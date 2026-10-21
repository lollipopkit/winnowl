import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { fetchUpstreamModels, listModels, resolveDefaultModel, resolvePlan, syncModelCatalog, MODELS_DEV_SOURCE } from '@reviewbot/entitlement';
import { REVIEW_STAGES, STAGE_STRATEGIES, isReviewStage, isStageStrategy } from '@reviewbot/domain';
import { requirePermission } from '../rbac.js';
import { isPlatformOperator } from '../platform-operator.js';

function tenantOf(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) {
    void reply.code(400).send({ error: 'no_tenant_in_context' });
    return undefined;
  }
  return tenantId;
}

/**
 * `/v1/platform/**` manages cross-tenant catalogs (plans, models, stage models), so it is gated by
 * isPlatformOperator rather than tenant roles. `/v1/subscription/models` is tenant read-only.
 */
/** `metadata` is a soft reference to `model_catalog`. */
interface ModelBody {
  provider?: string;
  modelId?: string;
  sort?: number;
  active?: boolean;
  /** null = clear (fall back to the built-in catalog). */
  metadata?: { source?: string; provider?: string; modelId?: string } | null;
}

/** All three fields or none: a partial reference can never resolve. */
function validateMetadataRef(b: ModelBody): string | undefined {
  const md = b.metadata;
  if (md === undefined || md === null) return undefined;
  if (!md.source || !md.provider || !md.modelId) return 'metadata 需同时给 source/provider/modelId,或传 null 清空';
  return undefined;
}

function metadataColumns(b: ModelBody): { metadata_source: string | null; metadata_provider: string | null; metadata_model_id: string | null } {
  const md = b.metadata;
  return md
    ? { metadata_source: md.source!, metadata_provider: md.provider!, metadata_model_id: md.modelId! }
    : { metadata_source: null, metadata_provider: null, metadata_model_id: null };
}

async function catalogSize(db: Db): Promise<number> {
  const r = await db
    .selectFrom('model_catalog')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}

export function registerPlanRoutes(app: FastifyInstance, db: Db): void {
  const operatorOnly = requirePermission('review:read');

  app.get('/v1/platform/models', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    return { items: await listModels(db) };
  });

  // Gateway model ids, marked if already registered and matched to catalog specs by id.
  // The endpoint comes from env only: the request carries the platform API key.
  app.get('/v1/platform/models/upstream', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    let list;
    try {
      list = await fetchUpstreamModels();
    } catch (err) {
      // Gateway lacks /models or is down: not an error, the UI falls back to manual entry.
      return { items: [], defaultProvider: process.env.LLM_PROVIDER ?? 'openai', unavailable: (err as Error).message };
    }
    const registered = new Set((await listModels(db)).map((m) => `${m.provider}/${m.modelId}`));
    // Gateway ids and models.dev modelIds share a namespace; exact match only.
    const catalog = await db
      .selectFrom('model_catalog')
      .select(['source', 'provider', 'model_id', 'name', 'context_window', 'max_tokens', 'reasoning', 'input', 'cost'])
      .where(
        'model_id',
        'in',
        list.items.map((m) => m.id),
      )
      .execute();
    const byId = new Map<string, (typeof catalog)[number]>();
    for (const c of catalog) if (!byId.has(c.model_id)) byId.set(c.model_id, c);
    return {
      defaultProvider: list.defaultProvider,
      items: list.items.map((m) => {
        const c = byId.get(m.id);
        return {
          ...m,
          registered: registered.has(`${list.defaultProvider}/${m.id}`),
          ...(c
            ? {
                catalog: {
                  source: c.source,
                  provider: c.provider,
                  modelId: c.model_id,
                  name: c.name,
                  contextWindow: c.context_window,
                  maxTokens: c.max_tokens,
                  reasoning: c.reasoning,
                  input: c.input,
                  cost: c.cost,
                },
              }
            : {}),
        };
      }),
    };
  });

  app.post('/v1/platform/models', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const b = (req.body ?? {}) as ModelBody;
    if (!b.provider || !b.modelId) {
      return reply.code(400).send({ error: 'provider/modelId 必填' });
    }
    const mdErr = validateMetadataRef(b);
    if (mdErr) return reply.code(400).send({ error: mdErr });
    // No baseUrl/apiKey: endpoints and keys live only in env, so DB write access cannot redirect prompts.
    const id = uuidv7();
    await db
      .insertInto('models')
      .values({
        id,
        provider: b.provider,
        model_id: b.modelId,
        ...metadataColumns(b),
        active: b.active ?? true,
        sort: b.sort ?? 100,
        created_at: new Date(),
      })
      // Identity is (provider, model_id).
      .onConflict((oc) =>
        oc.columns(['provider', 'model_id']).doUpdateSet({
          ...metadataColumns(b),
          ...(b.active === undefined ? {} : { active: b.active }),
          ...(b.sort === undefined ? {} : { sort: b.sort }),
        }),
      )
      .execute();
    return { ok: true, id };
  });

  /** Edits by row id so changing identifying fields updates the row instead of creating another. */
  app.put('/v1/platform/models/:id', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as ModelBody;
    if (!b.provider || !b.modelId) {
      return reply.code(400).send({ error: 'provider/modelId 必填' });
    }
    const mdErr = validateMetadataRef(b);
    if (mdErr) return reply.code(400).send({ error: mdErr });
    const existing = await db.selectFrom('models').select('id').where('id', '=', id).executeTakeFirst();
    if (!existing) return reply.code(404).send({ error: 'model_not_found', id });
    // Report a duplicate (provider, model id) explicitly instead of a unique-violation 500.
    const clash = await db
      .selectFrom('models')
      .select('id')
      .where('provider', '=', b.provider)
      .where('model_id', '=', b.modelId)
      .where('id', '!=', id)
      .executeTakeFirst();
    if (clash) return reply.code(409).send({ error: 'model_exists', provider: b.provider, modelId: b.modelId });

    await db
      .updateTable('models')
      .set({
        provider: b.provider,
        model_id: b.modelId,
        ...metadataColumns(b),
        ...(b.active === undefined ? {} : { active: b.active }),
        ...(b.sort === undefined ? {} : { sort: b.sort }),
      })
      .where('id', '=', id)
      .execute();
    req.log.info({ id, provider: b.provider, modelId: b.modelId, actor: req.auth?.actorId ?? null }, 'platform model updated');
    return { ok: true, id };
  });

  /**
   * Cascades to `plan_stage_models` and returns the affected stages, since they silently change model.
   * A stage left without models is valid (it uses the default).
   */
  app.delete('/v1/platform/models/:id', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const { id } = req.params as { id: string };
    const model = await db.selectFrom('models').select(['id', 'provider', 'model_id']).where('id', '=', id).executeTakeFirst();
    if (!model) return reply.code(404).send({ error: 'model_not_found', id });

    // Read before the cascade removes them.
    const attached = await db
      .selectFrom('plan_stage_models')
      .innerJoin('plans', 'plans.id', 'plan_stage_models.plan_id')
      .select(['plans.key as planKey', 'plan_stage_models.stage as stage'])
      .where('plan_stage_models.model_id', '=', model.id)
      .execute();

    await db.deleteFrom('models').where('id', '=', model.id).execute();
    const detachedFrom = attached.map((a) => `${a.planKey}/${a.stage}`);
    req.log.info({ id, provider: model.provider, modelId: model.model_id, detachedFrom, actor: req.auth?.actorId ?? null }, 'platform model deleted');
    return { ok: true, detachedFrom };
  });

  // Model metadata catalog.
  app.get('/v1/platform/model-catalog', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const q = (req.query ?? {}) as { q?: string; limit?: string };
    // Search is required (thousands of entries). An empty query returns nothing rather than a misleading truncated list.
    const term = (q.q ?? '').trim().toLowerCase();
    if (!term) return { items: [], total: await catalogSize(db) };
    const limit = Math.min(Number(q.limit) || 50, 200);
    const rows = await db
      .selectFrom('model_catalog')
      .select(['source', 'provider', 'model_id', 'name', 'context_window', 'max_tokens', 'reasoning', 'input', 'cost'])
      .where((eb) =>
        eb.or([
          eb('model_id', 'ilike', `%${term}%`),
          eb('name', 'ilike', `%${term}%`),
          eb('provider', 'ilike', `%${term}%`),
        ]),
      )
      .orderBy('provider')
      .orderBy('model_id')
      .limit(limit)
      .execute();
    return {
      total: await catalogSize(db),
      items: rows.map((r) => ({
        source: r.source,
        provider: r.provider,
        modelId: r.model_id,
        name: r.name,
        contextWindow: r.context_window,
        maxTokens: r.max_tokens,
        reasoning: r.reasoning,
        input: r.input.split(','),
        cost: r.cost,
      })),
    };
  });

  /** Returns added/removed/repriced entries; price changes affect cost caps. */
  app.post('/v1/platform/model-catalog/sync', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    try {
      const r = await syncModelCatalog(db);
      req.log.info({ ...r, repriced: r.repriced.length, actor: req.auth?.actorId ?? null }, 'model catalog synced');
      return r;
    } catch (e) {
      // Upstream failure is reported as a sync failure, not a 500.
      req.log.warn({ err: (e as Error).message }, 'model catalog sync failed');
      return reply.code(502).send({ error: 'catalog_sync_failed', message: (e as Error).message, source: MODELS_DEV_SOURCE });
    }
  });

  /*
   * Takes the full order and writes it in one transaction, avoiding lost updates and half-applied orders
   * from per-row PUTs. Step 10 leaves room for manual inserts.
   */
  app.post('/v1/platform/models/reorder', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || ids.some((k) => typeof k !== 'string' || !k)) {
      return reply.code(400).send({ error: 'ids 必须是非空字符串数组' });
    }
    if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: 'ids 有重复' });
    await db.transaction().execute(async (trx) => {
      for (const [i, modelRowId] of (ids as string[]).entries()) {
        await trx
          .updateTable('models')
          .set({ sort: (i + 1) * 10 })
          .where('id', '=', modelRowId)
          .execute();
      }
    });
    return { ok: true };
  });

  app.get('/v1/platform/plans', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const plans = await db
      .selectFrom('plans')
      .select(['id', 'key', 'name', 'model_tier', 'monthly_cost_cap_usd', 'monthly_review_quota', 'monthly_token_quota', 'max_concurrency', 'active'])
      .orderBy('key')
      .execute();
    return {
      items: plans.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        modelTier: p.model_tier,
        monthlyCostCapUsd: p.monthly_cost_cap_usd === null ? null : Number(p.monthly_cost_cap_usd),
        monthlyReviewQuota: p.monthly_review_quota,
        monthlyTokenQuota: p.monthly_token_quota === null ? null : Number(p.monthly_token_quota),
        maxConcurrency: p.max_concurrency,
        active: p.active,
      })),
    };
  });

  app.put('/v1/platform/plans/:key', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const { key } = req.params as { key: string };
    const b = (req.body ?? {}) as {
      name?: string;
      modelTier?: string;
      monthlyCostCapUsd?: number | null;
      monthlyReviewQuota?: number | null;
      monthlyTokenQuota?: number | null;
      maxConcurrency?: number;
      active?: boolean;
    };
    if (!b.name) return reply.code(400).send({ error: 'name 必填' });
    if (b.monthlyCostCapUsd !== undefined && b.monthlyCostCapUsd !== null && !(b.monthlyCostCapUsd > 0)) {
      // 0 would make checkQuota report over quota immediately; uncapped is null.
      return reply.code(400).send({ error: 'monthlyCostCapUsd 须 >0,或用 null 表示不限成本' });
    }
    const values = {
      name: b.name,
      model_tier: b.modelTier ?? 'balanced',
      monthly_cost_cap_usd: b.monthlyCostCapUsd ?? null,
      monthly_review_quota: b.monthlyReviewQuota ?? null,
      monthly_token_quota: b.monthlyTokenQuota ?? null,
      max_concurrency: b.maxConcurrency ?? 2,
      active: b.active ?? true,
    };
    await db
      .insertInto('plans')
      .values({ id: uuidv7(), key, ...values, features: JSON.stringify({}) as unknown as Record<string, unknown>, created_at: new Date() })
      .onConflict((oc) => oc.column('key').doUpdateSet(values))
      .execute();
    return { ok: true };
  });

  // Per-stage models are the only place that decides which models a plan runs; a stage without models
  // uses the first active model by sort (`resolveDefaultModel`).
  app.get('/v1/platform/plans/:key/stage-models', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const { key } = req.params as { key: string };
    const plan = await db.selectFrom('plans').select('id').where('key', '=', key).executeTakeFirst();
    if (!plan) return reply.code(404).send({ error: 'plan_not_found' });
    const [rows, policies] = await Promise.all([
      db.selectFrom('plan_stage_models').select(['stage', 'model_id']).where('plan_id', '=', plan.id).orderBy('sort').orderBy('model_id').execute(),
      db.selectFrom('plan_stage_policies').select(['stage', 'strategy']).where('plan_id', '=', plan.id).execute(),
    ]);
    const strategyOf = new Map(policies.map((p) => [p.stage, p.strategy]));
    return {
      strategies: STAGE_STRATEGIES,
      items: REVIEW_STAGES.map((stage) => ({
        stage,
        strategy: strategyOf.get(stage) ?? 'fill-first',
        modelIds: rows.filter((r) => r.stage === stage).map((r) => r.model_id),
      })),
    };
  });

  /** Replaces the stage's model list (in `modelIds` order) and strategy. */
  app.put('/v1/platform/plans/:key/stage-models/:stage', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const { key, stage } = req.params as { key: string; stage: string };
    if (!isReviewStage(stage)) return reply.code(400).send({ error: 'unknown_stage', stage, known: REVIEW_STAGES });
    const plan = await db.selectFrom('plans').select('id').where('key', '=', key).executeTakeFirst();
    if (!plan) return reply.code(404).send({ error: 'plan_not_found' });
    const b = (req.body ?? {}) as { modelIds?: string[]; strategy?: string };
    const modelIds = b.modelIds ?? [];
    if (new Set(modelIds).size !== modelIds.length) return reply.code(400).send({ error: 'modelIds 有重复' });
    const strategy = b.strategy ?? 'fill-first';
    if (!isStageStrategy(strategy)) return reply.code(400).send({ error: 'unknown_strategy', strategy, known: STAGE_STRATEGIES });
    // Reject unknown models: the runtime join would silently drop them.
    const known = modelIds.length > 0 ? await db.selectFrom('models').select('id').where('id', 'in', modelIds).execute() : [];
    const missing = modelIds.filter((id) => !known.some((m) => m.id === id));
    if (missing.length > 0) return reply.code(400).send({ error: 'unknown_models', missing });

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('plan_stage_models').where('plan_id', '=', plan.id).where('stage', '=', stage).execute();
      if (modelIds.length > 0) {
        await trx
          .insertInto('plan_stage_models')
          .values(modelIds.map((id, i) => ({ plan_id: plan.id, stage, model_id: id, sort: (i + 1) * 10 })))
          .execute();
      }
      await trx
        .insertInto('plan_stage_policies')
        .values({ plan_id: plan.id, stage, strategy, updated_at: new Date(), updated_by: req.auth?.actorId ?? null })
        .onConflict((oc) => oc.columns(['plan_id', 'stage']).doUpdateSet({ strategy, updated_at: new Date(), updated_by: req.auth?.actorId ?? null }))
        .execute();
    });
    req.log.info({ plan: key, stage, strategy, count: modelIds.length, actor: req.auth?.actorId ?? null }, 'plan stage models updated');
    return { ok: true, stage, count: modelIds.length };
  });

  app.get('/v1/subscription/models', { preHandler: requirePermission('plan:read') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { plan } = await resolvePlan(db, tenantId);
    const eff = await resolveDefaultModel(db);
    return {
      planKey: plan.key,
      allowed: eff.allowed,
      /** Model for stages without a configured list; null = empty registry (env/tier). */
      effectiveId: eff.model?.id ?? null,
    };
  });
}
