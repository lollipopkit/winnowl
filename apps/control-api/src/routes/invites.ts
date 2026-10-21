import { runWithoutTenant, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { FastifyInstance } from 'fastify';

/** Any authenticated user can accept with a valid, unused token whose email matches theirs. */
export function registerInviteRoutes(app: FastifyInstance, db: Db): void {
  app.post('/v1/invites/:token/accept', async (req, reply) => {
    const userId = req.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'authentication_required' });
    const { token } = req.params as { token: string };
    // Cross-tenant: the accepting user has no (or another) tenant context; the token + email match is the authorization.
    const invite = await runWithoutTenant(() =>
      db.selectFrom('tenant_invites').selectAll().where('token', '=', token).executeTakeFirst(),
    );
    if (!invite || invite.accepted_at) return reply.code(404).send({ error: 'invite_not_found_or_used' });
    if (invite.expires_at.getTime() < Date.now()) return reply.code(409).send({ error: 'invite_expired' });
    // Same escape: the lookup is user-scoped, not tenant-scoped (users carries no tenant_id today,
    // but the accept flow is deliberately tenant-independent end to end).
    const user = await runWithoutTenant(() =>
      db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirst(),
    );
    if (!user || user.email.toLowerCase() !== invite.email.toLowerCase()) {
      return reply.code(403).send({ error: 'invite_email_mismatch' });
    }
    await runWithoutTenant(() => db.transaction().execute(async (trx) => {
      await trx
        .insertInto('memberships')
        .values({ id: uuidv7(), tenant_id: invite.tenant_id, user_id: userId, role: invite.role, status: 'active', created_at: new Date() })
        .onConflict((oc) => oc.columns(['tenant_id', 'user_id']).doUpdateSet({ role: invite.role, status: 'active' }))
        .execute();
      await trx.updateTable('tenant_invites').set({ accepted_at: new Date() }).where('id', '=', invite.id).execute();
    }));
    return { tenantId: invite.tenant_id, role: invite.role };
  });
}
