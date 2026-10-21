import type { FastifyInstance } from 'fastify';
import type { Db } from '@reviewbot/db';
import { listIdentities, unlinkIdentity } from '@reviewbot/entitlement';
import { requirePermission } from '../rbac.js';

/**
 * List and unlink identities. Linking happens in the OAuth callback (`?mode=link`), never here.
 * `plan:read` (every viewer) because this concerns the user's own account, not a tenant role.
 */
export function registerAccountRoutes(app: FastifyInstance, db: Db): void {
  const self = requirePermission('plan:read');

  /*
   * TODO(remove): these routes are user-scoped and only work because `user_identities` has no RLS.
   * Wrap them in `runWithoutTenant` (as `/v1/me` does) when RLS is enabled on that table.
   */
  app.get('/v1/account/identities', { preHandler: self }, async (req, reply) => {
    const userId = req.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'no_user_in_context' });
    return { items: await listIdentities(db, userId) };
  });

  app.delete('/v1/account/identities/:id', { preHandler: self }, async (req, reply) => {
    const userId = req.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'no_user_in_context' });
    const { id } = req.params as { id: string };
    const res = await unlinkIdentity(db, userId, id);
    if (res.ok) return { ok: true };
    if (res.reason === 'not_found') return reply.code(404).send({ error: 'identity_not_found' });
    return reply.code(409).send({ error: 'last_identity', reason: '至少保留一条身份,否则将无法再登录' });
  });
}
