import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const TENANT = uuidv7();

describe('档位 / 模型注册表端点(0046:档位可自定义 + 费用上限;0070:模型按阶段配)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let operator: FastifyInstance;
  /** Tenant owner with billing:manage, not a platform operator. */
  let owner: FastifyInstance;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    process.env.PLATFORM_OPERATOR_IDENTITIES = 'github:root';
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    operator = await buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role: 'owner', scopes: ['admin'], tenantId: TENANT, actorId: 'root', identity: { provider: 'github', issuer: 'https://github.com', subject: 'root' } }) } });
    owner = await buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role: 'owner', scopes: ['admin'], tenantId: TENANT, actorId: 'alice' }) } });
    await operator.ready();
    await owner.ready();
  });

  afterAll(async () => {
    await operator?.close();
    await owner?.close();
    await stop?.();
    delete process.env.PLATFORM_OPERATOR_IDENTITIES;
  });

  it('平台目录端点**只有平台运维**能进 —— 租户 owner 一律 403', async () => {
    for (const url of ['/v1/platform/models', '/v1/platform/models/upstream', '/v1/platform/plans']) {
      expect((await owner.inject({ method: 'GET', url })).statusCode).toBe(403);
    }
    expect((await owner.inject({ method: 'PUT', url: '/v1/platform/plans/x', payload: { name: 'X' } })).statusCode).toBe(403);
  });

  // A failed upstream fetch returns 200 + `unavailable` so the UI can fall back to manual entry.
  it('网关拉不到清单 → 仍 200,带 unavailable 供界面退回手填', async () => {
    const saved = process.env.LLM_BASE_URL;
    delete process.env.LLM_BASE_URL;
    const res = await operator.inject({ method: 'GET', url: '/v1/platform/models/upstream' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; unavailable?: string; defaultProvider: string };
    expect(body.items).toEqual([]);
    expect(body.unavailable).toMatch(/LLM_BASE_URL/);
    expect(body.defaultProvider).toBeTruthy();
    if (saved !== undefined) process.env.LLM_BASE_URL = saved;
  });

  it('登记模型 → 建自定义档位(档位数量不设限,不是固定四档)', async () => {
    for (const m of [
      { provider: 'openai', modelId: 'gpt-4o-mini', sort: 10 },
      { provider: 'openai', modelId: 'gpt-4o', sort: 20 },
    ]) {
      expect((await operator.inject({ method: 'POST', url: '/v1/platform/models', payload: m })).statusCode).toBe(200);
    }
    // POSTing the same (provider, model id) again upserts.
    expect((await operator.inject({ method: 'POST', url: '/v1/platform/models', payload: { provider: 'openai', modelId: 'gpt-4o-mini', templateModelId: 'gpt-4o' } })).statusCode).toBe(200);

    // Endpoints and keys must never be storable via the API; fails if models gains base_url/api_key.
    expect((await operator.inject({ method: 'POST', url: '/v1/platform/models', payload: { provider: 'openai', modelId: 'gpt-4o-mini', baseUrl: 'https://evil/v1', apiKey: 'sk-leak' } })).statusCode).toBe(200);
    const stored = await db.selectFrom('models').selectAll().where('model_id', '=', 'gpt-4o-mini').executeTakeFirstOrThrow();
    expect(Object.keys(stored).sort()).toEqual(
      ['active', 'created_at', 'id', 'metadata_model_id', 'metadata_provider', 'metadata_source', 'model_id', 'provider', 'sort'],
    );
    expect((await operator.inject({ method: 'PUT', url: '/v1/platform/plans/starter', payload: { name: 'Starter', monthlyCostCapUsd: 25, maxConcurrency: 3 } })).statusCode).toBe(200);

    const plans = (await operator.inject({ method: 'GET', url: '/v1/platform/plans' })).json() as {
      items: (Record<string, unknown> & { key: string; monthlyCostCapUsd: number | null })[];
    };
    const starter = plans.items.find((p) => p.key === 'starter')!;
    expect(starter.monthlyCostCapUsd).toBe(25);
    // Plans carry no model set; stage-models decide.
    expect(starter.models).toBeUndefined();
  });

  it('成本上限 0 被拒 —— 0 会被判成「立刻超额」,等于把档位做成不可用', async () => {
    const r = await operator.inject({ method: 'PUT', url: '/v1/platform/plans/broken', payload: { name: 'Broken', monthlyCostCapUsd: 0 } });
    expect(r.statusCode).toBe(400);
    // Uncapped is null, not 0.
    expect((await operator.inject({ method: 'PUT', url: '/v1/platform/plans/broken', payload: { name: 'Broken', monthlyCostCapUsd: null } })).statusCode).toBe(200);
  });

  it('未登记的模型 → 400(不静默丢弃:运行时那道 join 会把它滤掉,界面上却配着)', async () => {
    const econId = (await db.selectFrom('models').select('id').where('model_id', '=', 'gpt-4o-mini').executeTakeFirstOrThrow()).id;
    const ghost = '00000000-0000-7000-8000-000000000000';
    const unknown = await operator.inject({ method: 'PUT', url: '/v1/platform/plans/starter/stage-models/dig', payload: { modelIds: [econId, ghost] } });
    expect(unknown.statusCode).toBe(400);
    expect((unknown.json() as { missing: string[] }).missing).toEqual([ghost]);
    // A rejected request stores nothing.
    expect(await db.selectFrom('plan_stage_models').select('model_id').where('stage', '=', 'dig').execute()).toEqual([]);
  });

  // Tenants can only read their model; the write endpoint must not exist.
  it('租户侧模型端点只读:能看见生效模型,没有任何改的路径', async () => {
    const plan = await db.selectFrom('plans').select('id').where('key', '=', 'starter').executeTakeFirstOrThrow();
    await db.insertInto('subscriptions').values({ id: uuidv7(), tenant_id: TENANT, plan_id: plan.id, status: 'active', overage_policy: 'reject', current_period_start: new Date(), current_period_end: null, created_at: new Date(), updated_at: new Date() }).execute();

    const econId = (await db.selectFrom('models').select('id').where('model_id', '=', 'gpt-4o-mini').executeTakeFirstOrThrow()).id;
    const view = (await owner.inject({ method: 'GET', url: '/v1/subscription/models' })).json() as { effectiveId: string | null; allowed: { modelId: string }[] };
    expect(view.allowed.map((m) => m.modelId)).toEqual(['gpt-4o-mini', 'gpt-4o']);
    expect(view.effectiveId).toBe(econId); // first by sort

    expect((await owner.inject({ method: 'PUT', url: '/v1/subscription/model', payload: { modelKey: 'top' } })).statusCode).toBe(404);
  });

  it('待批安装(0044):operator 可列/可批,批准即补做当初被拦下的开通', async () => {
    const pid = uuidv7();
    await db.insertInto('pending_installations').values({
      id: pid, provider: 'github', installation_native_id: '990011', account_login: 'stranger',
      installer_provider_user_id: '4242', installer_login: 'someone', status: 'pending',
      decided_by: null, decided_at: null, created_at: new Date(),
    }).execute();

    expect((await owner.inject({ method: 'GET', url: '/v1/pending-installations' })).statusCode).toBe(403);

    const list = (await operator.inject({ method: 'GET', url: '/v1/pending-installations?status=pending' })).json() as {
      items: { id: string; accountLogin: string; installerLogin: string; status: string; createdAt: string }[];
    };
    const row = list.items.find((x) => x.id === pid)!;
    expect(row.accountLogin).toBe('stranger');
    expect(row.installerLogin).toBe('someone');
    expect(row.createdAt).toMatch(/^\d{4}-/);

    // Approval provisions the tenant (idempotent) and records the decider.
    expect((await operator.inject({ method: 'POST', url: `/v1/pending-installations/${pid}/approve` })).statusCode).toBe(200);
    const after = await db.selectFrom('pending_installations').select(['status', 'decided_by']).where('id', '=', pid).executeTakeFirstOrThrow();
    expect(after.status).toBe('approved');
    expect(after.decided_by).toBe('root');
    const inst = await db.selectFrom('installations').select('account_login').where('native_id', '=', '990011').executeTakeFirst();
    expect(inst?.account_login).toBe('stranger');

    expect((await operator.inject({ method: 'POST', url: `/v1/pending-installations/${pid}/approve` })).statusCode).toBe(404);
  });

  it('待批安装审批不会把未知 provider 错开成 GitHub', async () => {
    const pid = uuidv7();
    await db.insertInto('pending_installations').values({
      id: pid, provider: 'forgejo', installation_native_id: 'fj-1', account_login: 'forge',
      installer_provider_user_id: '7', installer_login: 'alice', status: 'pending',
      decided_by: null, decided_at: null, created_at: new Date(),
    }).execute();

    const response = await operator.inject({ method: 'POST', url: `/v1/pending-installations/${pid}/approve` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'pending_installation_provider_not_supported',
      provider: 'forgejo',
    });
    expect(await db.selectFrom('pending_installations').select('status').where('id', '=', pid).executeTakeFirstOrThrow()).toEqual({ status: 'pending' });
  });

  it('待批安装 approve/reject 并发时只有一个决策和副作用生效', async () => {
    const pid = uuidv7();
    const nativeId = `race-${uuidv7()}`;
    await db.insertInto('pending_installations').values({
      id: pid, provider: 'github', installation_native_id: nativeId, account_login: 'race-org',
      installer_provider_user_id: 'race-user', installer_login: 'racer', status: 'pending',
      decided_by: null, decided_at: null, created_at: new Date(),
    }).execute();

    const [approve, reject] = await Promise.all([
      operator.inject({ method: 'POST', url: `/v1/pending-installations/${pid}/approve` }),
      operator.inject({ method: 'POST', url: `/v1/pending-installations/${pid}/reject` }),
    ]);
    expect([approve.statusCode, reject.statusCode].sort()).toEqual([200, 404]);
    const decision = await db.selectFrom('pending_installations').select('status').where('id', '=', pid).executeTakeFirstOrThrow();
    const installation = await db.selectFrom('installations').select('id').where('native_id', '=', nativeId).executeTakeFirst();
    expect(decision.status === 'approved').toBe(Boolean(installation));
  });

  it('重排整表(拖动排序):按 ids 顺序重写 sort,坏输入一律拒绝', async () => {
    const idOf = async (modelId: string): Promise<string> =>
      (await db.selectFrom('models').select('id').where('model_id', '=', modelId).executeTakeFirstOrThrow()).id;
    // Earlier tests registered gpt-4o-mini (sort 10) and gpt-4o (sort 20); reverse them.
    const econId = await idOf('gpt-4o-mini');
    const topId = await idOf('gpt-4o');
    const ok = await operator.inject({ method: 'POST', url: '/v1/platform/models/reorder', payload: { ids: [topId, econId] } });
    expect(ok.statusCode).toBe(200);
    const rows = await db.selectFrom('models').select(['model_id', 'sort']).orderBy('sort').execute();
    expect(rows.map((r) => r.model_id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(rows.map((r) => r.sort)).toEqual([10, 20]);

    // Duplicate ids would make the order ambiguous.
    expect((await operator.inject({ method: 'POST', url: '/v1/platform/models/reorder', payload: { ids: [topId, topId] } })).statusCode).toBe(400);
    expect((await operator.inject({ method: 'POST', url: '/v1/platform/models/reorder', payload: { ids: topId } })).statusCode).toBe(400);
    expect((await owner.inject({ method: 'POST', url: '/v1/platform/models/reorder', payload: { ids: [topId] } })).statusCode).toBe(403);
    const after = await db.selectFrom('models').select(['model_id', 'sort']).orderBy('sort').execute();
    expect(after.map((r) => r.model_id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  // Deleting a model cascades to stages and returns the affected plan/stage pairs.
  it('删模型:强制摘掉配了它的阶段,并回传是哪几段', async () => {
    const idOf = async (modelId: string): Promise<string> =>
      (await db.selectFrom('models').select('id').where('model_id', '=', modelId).executeTakeFirstOrThrow()).id;

    const econId = await idOf('gpt-4o-mini');
    const topId = await idOf('gpt-4o');
    expect(
      (await operator.inject({ method: 'PUT', url: '/v1/platform/plans/starter/stage-models/map', payload: { modelIds: [econId, topId] } })).statusCode,
    ).toBe(200);

    const del = await operator.inject({ method: 'DELETE', url: `/v1/platform/models/${econId}` });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { detachedFrom: string[] }).detachedFrom).toEqual(['starter/map']);
    expect(await db.selectFrom('models').select('id').where('model_id', '=', 'gpt-4o-mini').executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('plan_stage_models').select('model_id').where('stage', '=', 'map').execute()).toEqual([{ model_id: topId }]);

    expect((await operator.inject({ method: 'DELETE', url: `/v1/platform/models/${econId}` })).statusCode).toBe(404);
    expect((await owner.inject({ method: 'DELETE', url: `/v1/platform/models/${topId}` })).statusCode).toBe(403);
  });

  // Edits go by row id, since provider and model id are editable.
  it('改模型按 id:改模型 id 是改这一行,不是新增一行;撞已有的 409', async () => {
    const before = await db.selectFrom('models').select('id').where('model_id', '=', 'gpt-4o').executeTakeFirstOrThrow();
    const res = await operator.inject({
      method: 'PUT',
      url: `/v1/platform/models/${before.id}`,
      payload: { provider: 'openai', modelId: 'gpt-4o-2026', sort: 20 },
    });
    expect(res.statusCode).toBe(200);
    const rows = await db.selectFrom('models').select(['id', 'provider', 'model_id']).execute();
    expect(rows).toEqual([{ id: before.id, provider: 'openai', model_id: 'gpt-4o-2026' }]);
    // Stages reference the row id, so the stage assignment survives.
    expect(await db.selectFrom('plan_stage_models').select('model_id').execute()).toEqual([{ model_id: before.id }]);

    // Duplicate (provider, model id) -> explicit conflict, not a 500.
    await operator.inject({ method: 'POST', url: '/v1/platform/models', payload: { provider: 'openai', modelId: 'm-other' } });
    const other = await db.selectFrom('models').select('id').where('model_id', '=', 'm-other').executeTakeFirstOrThrow();
    const clash = await operator.inject({
      method: 'PUT',
      url: `/v1/platform/models/${other.id}`,
      payload: { provider: 'openai', modelId: 'gpt-4o-2026' },
    });
    expect(clash.statusCode).toBe(409);
    expect((clash.json() as { error: string }).error).toBe('model_exists');

    expect((await owner.inject({ method: 'PUT', url: `/v1/platform/models/${other.id}`, payload: { provider: 'openai', modelId: 'z' } })).statusCode).toBe(403);
  });

  // Platform settings are cross-tenant: tenant owners cannot even read them.
  describe('/v1/platform/settings', () => {
    const KEY = 'review.finding_match';

    it('未设过 → 报默认值且标明来源;租户 owner 一律 403', async () => {
      const res = await operator.inject({ method: 'GET', url: '/v1/platform/settings' });
      expect(res.statusCode).toBe(200);
      const items = (res.json() as { items: { key: string; value: string; source: string; env: string; values: string[] }[] }).items;
      const m = items.find((i) => i.key === KEY)!;
      expect(m.value).toBe('llm');
      expect(m.source).toBe('default');
      expect(m.env).toBe('REVIEW_FINDING_MATCH');
      expect(m.values).toContain('off');

      expect((await owner.inject({ method: 'GET', url: '/v1/platform/settings' })).statusCode).toBe(403);
      expect((await owner.inject({ method: 'PUT', url: `/v1/platform/settings/${KEY}`, payload: { value: 'off' } })).statusCode).toBe(403);
    });

    it('改写后 source=database 且记下改动者;删除 = 回到 env/默认', async () => {
      expect((await operator.inject({ method: 'PUT', url: `/v1/platform/settings/${KEY}`, payload: { value: 'off' } })).statusCode).toBe(200);
      const after = (await operator.inject({ method: 'GET', url: '/v1/platform/settings' })).json() as {
        items: { key: string; value: string; source: string; updatedBy?: string }[];
      };
      const m = after.items.find((i) => i.key === KEY)!;
      expect(m).toMatchObject({ value: 'off', source: 'database', updatedBy: 'root' });

      expect((await operator.inject({ method: 'DELETE', url: `/v1/platform/settings/${KEY}` })).statusCode).toBe(200);
      const reset = (await operator.inject({ method: 'GET', url: '/v1/platform/settings' })).json() as { items: { key: string; source: string }[] };
      expect(reset.items.find((i) => i.key === KEY)!.source).toBe('default');
    });

    it('每次改动都留修改记录(含重置),重复写同值不记;非运维 403', async () => {
      await db.deleteFrom('platform_setting_changes').execute();
      const put = (value: string) => operator.inject({ method: 'PUT', url: `/v1/platform/settings/${KEY}`, payload: { value } });
      await put('off');
      await put('off');
      await put('llm');
      await operator.inject({ method: 'DELETE', url: `/v1/platform/settings/${KEY}` });
      const h = (await operator.inject({ method: 'GET', url: `/v1/platform/settings/${KEY}/history` })).json() as {
        items: { oldValue: string | null; newValue: string | null; actor: string }[];
      };
      expect(h.items.map((c) => [c.oldValue, c.newValue])).toEqual([
        ['llm', null],
        ['off', 'llm'],
        [null, 'off'],
      ]);
      expect(h.items.every((c) => c.actor === 'root')).toBe(true);
      expect((await owner.inject({ method: 'GET', url: `/v1/platform/settings/${KEY}/history` })).statusCode).toBe(403);
    });

    it('非法值与未知 key 都拒绝,并告诉调用方允许什么(静默忽略会让人以为设置生效了)', async () => {
      const bad = await operator.inject({ method: 'PUT', url: `/v1/platform/settings/${KEY}`, payload: { value: 'maybe' } });
      expect(bad.statusCode).toBe(400);
      expect((bad.json() as { error: string; allowed: string[] }).allowed).toEqual(['llm', 'off']);
      expect((await operator.inject({ method: 'PUT', url: '/v1/platform/settings/review.nope', payload: { value: 'llm' } })).statusCode).toBe(400);
      expect((await operator.inject({ method: 'DELETE', url: '/v1/platform/settings/review.nope' })).statusCode).toBe(400);
    });
  });

  it('/v1/subscription 暴露费用上限与本周期成本(前端画的是钱的进度条)', async () => {
    const sub = (await owner.inject({ method: 'GET', url: '/v1/subscription' })).json() as {
      plan: { monthlyCostCapUsd: number | null; monthlyReviewQuota: number | null };
      usage: { costUsd: number };
    };
    expect(sub.plan.monthlyCostCapUsd).toBe(25);
    expect(sub.plan.monthlyReviewQuota).toBeNull();
    expect(sub.usage.costUsd).toBe(0);
  });

  it('owner 可改超额行为(只允许 reject/degrade),写审计;admin 403', async () => {
    const put = (action: unknown, app = owner) =>
      app.inject({ method: 'PUT', url: '/v1/subscription/overage-policy', payload: { action } });
    expect((await put('degrade')).statusCode).toBe(200);
    expect(((await owner.inject({ method: 'GET', url: '/v1/subscription' })).json() as { overageAction: string }).overageAction).toBe('degrade');
    expect((await put('queue')).statusCode).toBe(400);
    const admin = await buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role: 'admin', scopes: ['admin'], tenantId: TENANT, actorId: 'bob' }) } });
    try {
      expect((await put('reject', admin)).statusCode).toBe(403);
    } finally {
      await admin.close();
    }
    expect((await put('reject')).statusCode).toBe(200);
    const audit = await db.selectFrom('audit_events').select('detail').where('action', '=', 'subscription.overage_policy').execute();
    expect(audit.map((a) => (a.detail as { action: string }).action)).toEqual(['degrade', 'reject']);
  });

  // Unconfigured = fill-first with empty lists, the state right after deployment.
  describe('按阶段配模型(0068:挂在档位上;0070:候选集 = 整个注册表)', () => {
    // Earlier tests left stage rows behind; start from a clean slate.
    beforeAll(async () => {
      await db.deleteFrom('plan_stage_models').execute();
      await db.deleteFrom('plan_stage_policies').execute();
    });

    it('未配 → 每个阶段都是 fill-first + 空列表(零行为变化)', async () => {
      const r = (await operator.inject({ method: 'GET', url: '/v1/platform/plans/starter/stage-models' })).json() as {
        strategies: string[];
        items: { stage: string; strategy: string; modelIds: string[] }[];
      };
      expect(r.items.map((i) => i.stage)).toEqual(['map', 'dig', 'synthesis', 'verify', 'refute', 'vlm']);
      expect(r.items.every((i) => i.strategy === 'fill-first' && i.modelIds.length === 0)).toBe(true);
      expect(r.strategies).toEqual(['fill-first', 'round-robin', 'random']);
    });

    it('整段替换列表与算法;顺序即 modelIds 的顺序', async () => {
      const a = (await db.selectFrom('models').select('id').orderBy('sort').orderBy('model_id').execute()).map((m) => m.id);
      expect(a.length).toBeGreaterThanOrEqual(2);
      const put = await operator.inject({
        method: 'PUT',
        url: '/v1/platform/plans/starter/stage-models/verify',
        payload: { modelIds: [a[1], a[0]], strategy: 'round-robin' },
      });
      expect(put.statusCode).toBe(200);
      const rows = await db.selectFrom('plan_stage_models').select(['model_id', 'sort']).where('stage', '=', 'verify').orderBy('sort').execute();
      expect(rows.map((r) => r.model_id)).toEqual([a[1], a[0]]);
      const got = (await operator.inject({ method: 'GET', url: '/v1/platform/plans/starter/stage-models' })).json() as { items: { stage: string; strategy: string; modelIds: string[] }[] };
      expect(got.items.find((i) => i.stage === 'verify')).toEqual({ stage: 'verify', strategy: 'round-robin', modelIds: [a[1], a[0]] });

      // Clearing falls back to the registry default.
      expect((await operator.inject({ method: 'PUT', url: '/v1/platform/plans/starter/stage-models/verify', payload: { modelIds: [] } })).statusCode).toBe(200);
      expect(await db.selectFrom('plan_stage_models').select('model_id').where('stage', '=', 'verify').execute()).toEqual([]);
    });

    it('坏输入一律拒:未知阶段 / 未知算法 / 未知档位 / 重复', async () => {
      const a = (await db.selectFrom('models').select('id').execute()).map((m) => m.id);
      const url = (stage: string, plan = 'starter'): string => `/v1/platform/plans/${plan}/stage-models/${stage}`;
      expect((await operator.inject({ method: 'PUT', url: url('nope'), payload: { modelIds: [] } })).statusCode).toBe(400);
      expect((await operator.inject({ method: 'PUT', url: url('dig'), payload: { modelIds: [], strategy: 'weighted' } })).statusCode).toBe(400);
      expect((await operator.inject({ method: 'PUT', url: url('dig', 'ghostplan'), payload: { modelIds: [] } })).statusCode).toBe(404);
      expect((await operator.inject({ method: 'PUT', url: url('dig'), payload: { modelIds: [a[0], a[0]] } })).statusCode).toBe(400);
      expect((await owner.inject({ method: 'PUT', url: url('dig'), payload: { modelIds: [] } })).statusCode).toBe(403);
    });

    // Inactive models stay configured but are filtered at runtime, so re-enabling restores the order.
    it('停用的模型仍留在配置里(停用不等于删除)', async () => {
      const [first] = await db.selectFrom('models').select('id').orderBy('sort').execute();
      expect((await operator.inject({ method: 'PUT', url: '/v1/platform/plans/starter/stage-models/refute', payload: { modelIds: [first.id] } })).statusCode).toBe(200);
      await db.updateTable('models').set({ active: false }).where('id', '=', first.id).execute();
      const got = (await operator.inject({ method: 'GET', url: '/v1/platform/plans/starter/stage-models' })).json() as { items: { stage: string; modelIds: string[] }[] };
      expect(got.items.find((i) => i.stage === 'refute')?.modelIds).toEqual([first.id]);
      await db.updateTable('models').set({ active: true }).where('id', '=', first.id).execute();
    });
  });
});
