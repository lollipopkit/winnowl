import { declineActionPlan } from '@reviewbot/actions';
import type { Db } from '@reviewbot/db';
import { hasPermission } from '@reviewbot/rbac';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { listInbox, type InboxViewer } from '../inbox.js';
import { isPlatformOperator } from '../platform-operator.js';
import { requirePermission } from '../rbac.js';

function viewerOf(req: FastifyRequest): InboxViewer | null {
  const auth = req.auth;
  if (!auth?.tenantId) return null;
  return {
    tenantId: auth.tenantId,
    actorId: auth.actorId ?? null,
    canApproveActions: hasPermission(auth.role, 'action:approve'),
    canApproveRules: hasPermission(auth.role, 'learning:approve'),
    canConfigure: hasPermission(auth.role, 'config:write'),
    isOperator: isPlatformOperator(auth),
  };
}

export function registerInboxRoutes(app: FastifyInstance, db: Db): void {
  const read = { preHandler: requirePermission('review:read') };

  app.get('/v1/inbox', read, async (req, reply) => {
    const viewer = viewerOf(req);
    if (!viewer) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const view = (req.query as { view?: string }).view === 'done' ? 'done' : 'pending';
    return { items: await listInbox(db, viewer, view) };
  });

  app.get('/v1/inbox/count', read, async (req, reply) => {
    const viewer = viewerOf(req);
    if (!viewer) return reply.code(400).send({ error: 'no_tenant_in_context' });
    return { pending: (await listInbox(db, viewer, 'pending')).length };
  });

  app.post('/v1/action-plans/:id/decline', read, async (req, reply) => {
    const viewer = viewerOf(req);
    if (!viewer) return reply.code(400).send({ error: 'no_tenant_in_context' });
    if (!viewer.actorId) return reply.code(400).send({ error: 'no_actor_in_context' });
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send({ error: 'not_found' });
    const result = await declineActionPlan(db, viewer.tenantId, {
      planId: id,
      actorId: viewer.actorId,
      actorAuthorized: viewer.canApproveActions,
    });
    if (result.ok) {
      await db
        .insertInto('audit_events')
        .values({
          id: crypto.randomUUID(),
          tenant_id: viewer.tenantId,
          actor: viewer.actorId,
          action: 'action-plan.declined',
          target: id,
          detail: {},
          created_at: new Date(),
        })
        .execute();
      return { status: 'declined' };
    }
    if (result.reason === 'plan not found') return reply.code(404).send({ error: 'not_found' });
    return reply.code(409).send({ error: result.reason });
  });
}
