import { randomUUID } from 'node:crypto';
import type { Db } from '@reviewbot/db';
import type { Role } from '@reviewbot/rbac';
import { uuidv7 } from '@reviewbot/ids';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requirePermission } from '../rbac.js';
import { mailMessages } from '../locale.js';
import type { Mailer } from '../mailer.js';

const ROLES = new Set<Role>(['owner', 'admin', 'member', 'viewer']);
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Uses the inviter's UI locale since the invitee's is unknown; falls back to English. */
function inviteEmailText(input: { locale?: string; tenantName: string; role: string; acceptUrl?: string; token: string; expiresAt: Date }): { subject: string; text: string } {
  const L = mailMessages(input.locale).inviteEmail;
  return {
    subject: L.subject({ tenant: input.tenantName }),
    text: [
      L.intro({ tenant: input.tenantName, role: input.role }),
      '',
      ...(input.acceptUrl ? [L.acceptWithLink(), input.acceptUrl] : [L.acceptWithToken(), input.token]),
      '',
      L.expires({ expiresAt: input.expiresAt.toISOString() }),
      L.ignore(),
    ].join('\n'),
  };
}

function tenantOf(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) void reply.code(400).send({ error: 'no_tenant_in_context' });
  return tenantId;
}

async function activeOwnerCount(db: Db, tenantId: string): Promise<number> {
  const r = await db
    .selectFrom('memberships')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('tenant_id', '=', tenantId)
    .where('role', '=', 'owner')
    .where('status', '=', 'active')
    .executeTakeFirstOrThrow();
  return Number(r.c);
}

async function isActiveOwner(db: Db, tenantId: string, userId: string): Promise<boolean> {
  const r = await db
    .selectFrom('memberships')
    .select('role')
    .where('tenant_id', '=', tenantId)
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return r?.role === 'owner';
}

export interface MemberRouteOptions {
  /** Omitted = the invite token is shared manually. */
  mailer?: Mailer;
  /** For the accept link; omitted = the email contains only the token. */
  consoleBaseUrl?: string;
}

export function registerMemberRoutes(app: FastifyInstance, db: Db, opts: MemberRouteOptions = {}): void {
  app.get('/v1/members', { preHandler: requirePermission('member:manage') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    return db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select([
        'memberships.user_id as userId',
        'users.email as email',
        'users.display_name as displayName',
        'memberships.role as role',
        'memberships.status as status',
        'memberships.created_at as createdAt',
      ])
      .where('memberships.tenant_id', '=', tenantId)
      .orderBy('memberships.created_at', 'asc')
      .execute();
  });

  app.post('/v1/members/invite', { preHandler: requirePermission('member:manage') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as { email?: string; role?: string; locale?: string };
    if (!body.email || !body.role || !ROLES.has(body.role as Role)) {
      return reply.code(400).send({ error: 'email_and_valid_role_required' });
    }
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const id = uuidv7();
    await db
      .insertInto('tenant_invites')
      .values({
        id,
        tenant_id: tenantId,
        email: body.email,
        role: body.role,
        token,
        invited_by: req.auth?.userId ?? null,
        expires_at: expiresAt,
        accepted_at: null,
        created_at: new Date(),
      })
      .execute();
    // A send failure is logged and does not revoke the invite; the token can still be shared manually.
    let emailSent = false;
    if (opts.mailer) {
      const tenant = await db.selectFrom('tenants').select('name').where('id', '=', tenantId).executeTakeFirst();
      const acceptUrl = opts.consoleBaseUrl ? `${opts.consoleBaseUrl.replace(/\/$/, '')}/invites/${token}` : undefined;
      try {
        const mail = inviteEmailText({
          ...(body.locale ? { locale: body.locale } : {}),
          tenantName: tenant?.name ?? 'a tenant',
          role: body.role,
          ...(acceptUrl ? { acceptUrl } : {}),
          token,
          expiresAt,
        });
        await opts.mailer({ to: body.email, subject: mail.subject, text: mail.text });
        emailSent = true;
      } catch (err) {
        req.log.warn({ err, inviteId: id }, '邀请邮件发送失败(邀请已创建,token 可手动分发)');
      }
    }
    return reply.code(201).send({ id, email: body.email, role: body.role, token, expiresAt, emailSent });
  });

  app.get('/v1/invites', { preHandler: requirePermission('member:manage') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    return db
      .selectFrom('tenant_invites')
      .select(['id', 'email', 'role', 'expires_at as expiresAt', 'created_at as createdAt'])
      .where('tenant_id', '=', tenantId)
      .where('accepted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute();
  });

  app.post('/v1/members/:userId/role', { preHandler: requirePermission('member:manage') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { userId } = req.params as { userId: string };
    const body = (req.body ?? {}) as { role?: string };
    if (!body.role || !ROLES.has(body.role as Role)) return reply.code(400).send({ error: 'valid_role_required' });
    if (body.role !== 'owner' && (await isActiveOwner(db, tenantId, userId)) && (await activeOwnerCount(db, tenantId)) <= 1) {
      return reply.code(409).send({ error: 'cannot_demote_last_owner' });
    }
    const res = await db
      .updateTable('memberships')
      .set({ role: body.role })
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return reply.code(404).send({ error: 'membership_not_found' });
    return { userId, role: body.role };
  });

  app.delete('/v1/members/:userId', { preHandler: requirePermission('member:manage') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { userId } = req.params as { userId: string };
    if ((await isActiveOwner(db, tenantId, userId)) && (await activeOwnerCount(db, tenantId)) <= 1) {
      return reply.code(409).send({ error: 'cannot_remove_last_owner' });
    }
    const res = await db.deleteFrom('memberships').where('tenant_id', '=', tenantId).where('user_id', '=', userId).executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return reply.code(404).send({ error: 'membership_not_found' });
    return { removed: userId };
  });
}
