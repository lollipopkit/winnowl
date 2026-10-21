import { runWithoutTenant, type Db } from '@reviewbot/db';
import {
  insertGlobalLearning,
  listGlobalLearningsPage,
  listPendingGlobalLearnings,
  loadGlobalLearning,
  loadGlobalLearningsPolicy,
  newGlobalLearning,
  transitionGlobalLearning,
  upsertGlobalLearningAdoption,
} from '@reviewbot/knowledge';
import type { FastifyInstance } from 'fastify';
import { paged, parseListParams, strFilter } from '../list-query.js';
import { requirePlatformOperator } from '../platform-operator.js';
import { parseExpiry } from '../expiry.js';
import { requirePermission } from '../rbac.js';

const GLOBAL_LEARNING_SORTS = ['createdAt', 'status'] as const;

/**
 * Operators propose/approve global learnings (source/deliberation are operator-only);
 * tenants see a pending inbox and adopt/decline with allowlisted fields only.
 */
export function registerGlobalLearningRoutes(app: FastifyInstance, db: Db): void {
  // Tenant routes. The static /pending path must be registered before /:id.
  app.get('/v1/global-learnings/pending', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    // listPendingGlobalLearnings returns allowlisted fields only (no source/deliberation).
    return listPendingGlobalLearnings(db, tenantId);
  });

  for (const action of ['adopt', 'decline'] as const) {
    app.post(`/v1/global-learnings/:id/${action}`, { preHandler: requirePermission('learning:approve') }, async (req, reply) => {
      const tenantId = req.auth?.tenantId;
      const actorId = req.auth?.actorId ?? 'unknown';
      if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { scope?: string; repositoryIds?: string[] };
      const scope = body.scope === 'repo' ? 'repo' : 'org';
      if (scope === 'repo' && (!Array.isArray(body.repositoryIds) || body.repositoryIds.length === 0)) {
        return reply.code(400).send({ error: 'repositoryIds_required_for_repo_scope' });
      }
      const g = await loadGlobalLearning(db, id);
      if (!g || g.status !== 'approved') return reply.code(404).send({ error: 'not_found' });
      // Mandatory learnings always apply and cannot be declined.
      if (g.enforcement === 'mandatory') return reply.code(409).send({ error: 'mandatory_not_adoptable' });
      await upsertGlobalLearningAdoption(db, tenantId, {
        globalLearningId: id,
        status: action === 'adopt' ? 'accepted' : 'declined',
        scope,
        ...(scope === 'repo' ? { repositoryIds: body.repositoryIds! } : {}),
        decidedBy: actorId,
      });
      return { status: action === 'adopt' ? 'accepted' : 'declined', scope };
    });
  }

  // Tenant policy: prompt | auto_accept | ignore.
  app.get('/v1/global-learnings-policy', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    return { policy: await loadGlobalLearningsPolicy(db, tenantId) };
  });
  app.put('/v1/global-learnings-policy', { preHandler: requirePermission('learning:approve') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const { policy } = (req.body ?? {}) as { policy?: string };
    if (policy !== 'prompt' && policy !== 'auto_accept' && policy !== 'ignore') {
      return reply.code(400).send({ error: 'invalid_policy' });
    }
    await db.updateTable('tenants').set({ global_learnings_policy: policy }).where('id', '=', tenantId).execute();
    return { policy };
  });

  // Operator routes.
  app.get('/v1/global-learnings', { preHandler: requirePlatformOperator }, async (req) => {
    const params = parseListParams(req.query, { sortable: GLOBAL_LEARNING_SORTS, defaultSort: 'createdAt' });
    const { items, total } = await listGlobalLearningsPage(db, {
      limit: params.limit,
      offset: params.offset,
      sort: params.sort,
      dir: params.dir,
      status: strFilter(req.query, 'status'),
      q: strFilter(req.query, 'q'),
    });
    return paged(items, total, params);
  });

  app.get('/v1/global-learnings/:id', { preHandler: requirePlatformOperator }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const learning = await loadGlobalLearning(db, id);
    if (!learning) return reply.code(404).send({ error: 'not_found' });
    const [counts, tenants] = await Promise.all([
      // Deliberately cross-tenant: adoption counts span every tenant, and an operator who is also a
      // tenant member would otherwise count only their own tenant's rows under RLS.
      runWithoutTenant(() =>
        db
          .selectFrom('global_learning_adoptions')
          .select((eb) => ['status', eb.fn.countAll<string>().as('n')])
          .where('global_learning_id', '=', id)
          .groupBy('status')
          .execute(),
      ),
      db.selectFrom('tenants').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    ]);
    const accepted = Number(counts.find((c) => c.status === 'accepted')?.n ?? 0);
    const declined = Number(counts.find((c) => c.status === 'declined')?.n ?? 0);
    const total = Number(tenants?.n ?? 0);
    return { ...learning, adoption: { accepted, declined, pending: Math.max(0, total - accepted - declined) } };
  });

  app.post('/v1/global-learnings', { preHandler: requirePlatformOperator }, async (req, reply) => {
    const actorId = req.auth!.actorId!; // guaranteed by requirePlatformOperator
    const body = (req.body ?? {}) as {
      locality?: string;
      selector?: string;
      instruction?: string;
      rationale?: string;
      enforcement?: string;
      expiresAt?: string;
    };
    if (!body.instruction || !body.rationale) {
      return reply.code(400).send({ error: 'instruction_rationale_required' });
    }
    const expiresAt = parseExpiry(body.expiresAt);
    if (expiresAt === 'invalid') return reply.code(400).send({ error: 'invalid_expires_at' });
    const g = newGlobalLearning({
      locality: body.locality === 'path' ? 'path' : 'none',
      ...(body.selector !== undefined ? { selector: body.selector } : {}),
      instruction: body.instruction,
      rationale: body.rationale,
      enforcement: body.enforcement === 'mandatory' ? 'mandatory' : 'default',
      proposedBy: actorId,
      ...(expiresAt ? { expiresAt: expiresAt.getTime() } : {}),
    });
    await insertGlobalLearning(db, g);
    return reply.code(201).send(g);
  });

  for (const action of ['approve', 'reject', 'revoke'] as const) {
    app.post(`/v1/global-learnings/:id/${action}`, { preHandler: requirePlatformOperator }, async (req, reply) => {
      const actorId = req.auth!.actorId!;
      const { id } = req.params as { id: string };
      const result = await transitionGlobalLearning(db, id, {
        action,
        actor: { isTenantAdmin: false, isPlatformOperator: true, ref: actorId },
      });
      if (!result.ok) return reply.code(409).send({ error: 'transition_rejected', reason: result.reason });
      const learning = await loadGlobalLearning(db, id);
      return { status: learning?.status, learning };
    });
  }
}
