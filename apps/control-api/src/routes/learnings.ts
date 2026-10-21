import type { Db } from '@reviewbot/db';
import {
  decideAgentMemoryProposal,
  insertLearningProposal,
  listLearningProposalsPage,
  newProposal,
  transitionAndPersist,
} from '@reviewbot/knowledge';
import { hasPermission, isAdminRole } from '@reviewbot/rbac';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { paged, parseListParams, strFilter } from '../list-query.js';
import { requirePermission } from '../rbac.js';
import { parseExpiry } from '../expiry.js';
import { listRules } from '../rules-read-model.js';

const LEARNING_SORTS = ['createdAt', 'status'] as const;

function tenantOf(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) void reply.code(400).send({ error: 'no_tenant_in_context' });
  return tenantId;
}

/** Propose: member+. Approve/reject/revoke: tenant admin+, for every broadness. */
export function registerLearningRoutes(app: FastifyInstance, db: Db): void {
  app.get('/v1/learnings', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const params = parseListParams(req.query, { sortable: LEARNING_SORTS, defaultSort: 'createdAt' });
    const { items, total } = await listLearningProposalsPage(db, tenantId, {
      limit: params.limit,
      offset: params.offset,
      sort: params.sort,
      dir: params.dir,
      status: strFilter(req.query, 'status'),
      q: strFilter(req.query, 'q'),
    });
    return paged(items, total, params);
  });

  // Tenant and platform rules as one list for the rules page.
  app.get('/v1/rules', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const params = parseListParams(req.query, { sortable: LEARNING_SORTS, defaultSort: 'createdAt' });
    return listRules(
      db,
      tenantId,
      { limit: params.limit, offset: params.offset },
      { scope: strFilter(req.query, 'scope'), state: strFilter(req.query, 'state'), q: strFilter(req.query, 'q') },
    );
  });

  app.post('/v1/learnings', { preHandler: requirePermission('learning:propose') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const auth = req.auth;
    if (!auth?.actorId) return reply.code(400).send({ error: 'no_actor_in_context' });
    const body = (req.body ?? {}) as {
      repositoryId?: string;
      broadness?: string;
      locality?: string;
      selector?: string;
      subjectRef?: string;
      instruction?: string;
      rationale?: string;
      expiresAt?: string;
    };
    if (!body.instruction || !body.rationale) {
      return reply.code(400).send({ error: 'instruction_rationale_required' });
    }
    const expiresAt = parseExpiry(body.expiresAt);
    if (expiresAt === 'invalid') return reply.code(400).send({ error: 'invalid_expires_at' });
    const broadness =
      body.broadness === 'organization' ? 'organization' : body.broadness === 'user' ? 'user' : 'repository';
    if (broadness === 'organization' && !hasPermission(auth.role, 'learning:propose:org')) {
      return reply.code(403).send({ error: 'forbidden', permission: 'learning:propose:org' });
    }
    if (broadness === 'repository' && !body.repositoryId) {
      return reply.code(400).send({ error: 'repositoryId_required_for_repository_broadness' });
    }
    // User broadness: subjectRef must be `provider:numeric-id`; logins can be renamed or recycled.
    if (broadness === 'user' && !body.subjectRef) {
      return reply.code(400).send({ error: 'subjectRef_required_for_user_broadness' });
    }
    if (broadness === 'user' && !/^[a-z]+:\d+$/.test(body.subjectRef!)) {
      return reply.code(400).send({ error: 'subjectRef_must_be_provider_user_id' });
    }
    const locality = body.locality === 'path' || body.locality === 'symbol' ? body.locality : 'none';
    const proposal = newProposal({
      repositoryId: broadness === 'repository' ? body.repositoryId! : null,
      broadness,
      locality,
      ...(body.selector !== undefined ? { selector: body.selector } : {}),
      ...(broadness === 'user' ? { subjectRef: body.subjectRef } : {}),
      instruction: body.instruction,
      rationale: body.rationale,
      proposedBy: auth.actorId,
      ...(expiresAt ? { expiresAt: expiresAt.getTime() } : {}),
    });
    await insertLearningProposal(db, tenantId, proposal);
    return reply.code(201).send(proposal);
  });

  for (const action of ['approve', 'reject', 'revoke'] as const) {
    app.post(`/v1/learnings/:id/${action}`, { preHandler: requirePermission('learning:approve') }, async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      if (!tenantId) return;
      const auth = req.auth;
      if (!auth?.actorId) return reply.code(400).send({ error: 'no_actor_in_context' });
      const { id } = req.params as { id: string };
      const result = await transitionAndPersist(db, tenantId, id, {
        action,
        actor: { isTenantAdmin: isAdminRole(auth.role), ref: auth.actorId },
      });
      if (!result.ok) return reply.code(409).send({ error: 'transition_rejected', reason: result.reason });
      return { status: result.proposal?.status, proposal: result.proposal };
    });
  }

  // Repository memories drafted from outside commenters; approval replaces the live entry with the same title.
  for (const action of ['approve', 'reject'] as const) {
    app.post(`/v1/memories/:id/${action}`, { preHandler: requirePermission('learning:approve') }, async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      if (!tenantId) return;
      const { id } = req.params as { id: string };
      const result = await decideAgentMemoryProposal(db, tenantId, id, action);
      if (!result.ok) return reply.code(result.reason === 'not_found' ? 404 : 409).send({ error: result.reason });
      return { status: result.memory.status, memory: result.memory };
    });
  }
}
