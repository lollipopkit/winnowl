import { randomUUID } from 'node:crypto';
import { runWithoutTenant, type Db } from '@reviewbot/db';
import { scopesForRole, type Role } from '@reviewbot/rbac';
import type { FastifyRequest } from 'fastify';
import { InvalidTokenError, type AuthContext, type AuthResolver } from './rbac.js';
import { parseCookies } from './auth/cookies.js';
import { SESSION_COOKIE, verifySession } from './auth/session.js';
import type { OAuthIdentity } from './auth/oauth.js';

const ANONYMOUS: AuthContext = { role: 'viewer', scopes: [] };
const ROLES = new Set<Role>(['owner', 'admin', 'member', 'viewer']);

function coerceRole(v: string): Role {
  return ROLES.has(v as Role) ? (v as Role) : 'viewer';
}

/** Selects the active tenant; absent = inferred from the single active membership. */
function requestedTenant(req: FastifyRequest): string | undefined {
  const h = req.headers['x-tenant-id'];
  return typeof h === 'string' && h ? h : undefined;
}

/** Placeholder address for JIT-created users; not deliverable. */
function isPlaceholderEmail(email: string): boolean {
  return email.endsWith('@oidc.local') || email.endsWith('@provider.local');
}

/**
 * Only SaaS issuers are trusted for merging by email: a self-hosted issuer can claim any address, which would
 * allow account takeover. Override with `EMAIL_MERGE_TRUSTED_ISSUERS` (comma-separated; empty disables merging).
 */
export function isTrustedForEmailMerge(issuer: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.EMAIL_MERGE_TRUSTED_ISSUERS ?? 'https://github.com,https://gitlab.com';
  const trusted = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  // The operator's own login IdP: its email_verified is what a sign-in relies on anyway.
  const oidcIssuer = env.OIDC_ISSUER?.trim();
  if (oidcIssuer) trusted.add(oidcIssuer);
  if (trusted.size === 0) return false;
  return trusted.has(issuer);
}

/** Matches by issuer + subject only, never login. */
async function findByIdentity(db: Db, identity: OAuthIdentity): Promise<string | null> {
  const row = await runWithoutTenant(() =>
    db
      .selectFrom('user_identities')
      .select('user_id')
      .where('kind', '=', identity.kind ?? 'provider')
      .where('issuer', '=', identity.issuer)
      .where('subject', '=', identity.subject)
      .executeTakeFirst(),
  );
  return row?.user_id ?? null;
}

/** Idempotent; an existing row only gets its display login refreshed. */
export async function attachIdentity(db: Db, userId: string, identity: OAuthIdentity): Promise<void> {
  await runWithoutTenant(() =>
    db
      .insertInto('user_identities')
      .values({
        id: randomUUID(),
        user_id: userId,
        kind: identity.kind ?? 'provider',
        issuer: identity.issuer,
        subject: identity.subject,
        login: identity.login ?? null,
        provider: identity.provider,
        tenant_id: null,
        created_at: new Date(),
      })
      .onConflict((oc) => oc.columns(['kind', 'issuer', 'subject']).doUpdateSet({ login: identity.login ?? null }))
      .execute(),
  );
}

/**
 * Resolves an external identity to a platform user: by (provider, issuer, subject) (the same key the webhook
 * side uses for installers), then by email if the issuer is trusted, else creates a user.
 */
export async function resolveOrCreateUser(db: Db, identity: OAuthIdentity): Promise<string> {
  const existing = await findByIdentity(db, identity);
  if (existing) {
    await attachIdentity(db, existing, identity);
    // Users created by the webhook installer path only have a placeholder email until first login.
    await upgradePlaceholderEmail(db, existing, identity.email);
    return existing;
  }

  const canMergeByEmail = identity.email !== undefined && isTrustedForEmailMerge(identity.issuer);
  const userEmail = identity.email ?? `${identity.provider}-${identity.subject}@provider.local`;
  await runWithoutTenant(() =>
    db.transaction().execute(async (trx) => {
      const taken = await trx.selectFrom('users').select('id').where('email', '=', userEmail).executeTakeFirst();
      // Email belongs to another user and merging is not trusted: use a unique placeholder (users.email is unique).
      const finalEmail = taken && !canMergeByEmail ? `${identity.provider}-${identity.subject}@provider.local` : userEmail;
      await trx
        .insertInto('users')
        .values({ id: randomUUID(), email: finalEmail, display_name: null, created_at: new Date() })
        .onConflict((oc) => oc.column('email').doNothing())
        .execute();
      const user = await trx.selectFrom('users').select('id').where('email', '=', finalEmail).executeTakeFirstOrThrow();
      await trx
        .insertInto('user_identities')
        .values({
          id: randomUUID(),
          user_id: user.id,
          kind: identity.kind ?? 'provider',
          issuer: identity.issuer,
          subject: identity.subject,
          login: identity.login ?? null,
          provider: identity.provider,
          tenant_id: null,
          created_at: new Date(),
        })
        .onConflict((oc) => oc.columns(['kind', 'issuer', 'subject']).doNothing())
        .execute();
    }),
  );

  const linked = await findByIdentity(db, identity);
  if (!linked) throw new Error('JIT 开号后仍找不到身份行'); // unreachable; never return the wrong user
  await upgradePlaceholderEmail(db, linked, identity.email);
  return linked;
}

/** Replaces a placeholder email with the forge's real one; never overwrites a real address. */
export async function upgradePlaceholderEmail(db: Db, userId: string, email: string | undefined): Promise<void> {
  if (!email || isPlaceholderEmail(email)) return;
  await runWithoutTenant(() =>
    db
      .updateTable('users')
      .set({ email })
      .where('id', '=', userId)
      .where((eb) => eb.or([eb('email', 'like', '%@oidc.local'), eb('email', 'like', '%@provider.local')]))
      .execute(),
  ).catch(() => undefined); // unique conflict with another user: keep the placeholder, do not block login
}

/** X-Tenant-Id if given, else the single active membership; several without the header = none (viewer). */
async function resolveActiveMembership(db: Db, userId: string, tenantId: string | undefined): Promise<{ tenantId: string; role: Role } | null> {
  const rows = await runWithoutTenant(() => {
    let q = db
      .selectFrom('memberships')
      .select(['tenant_id', 'role'])
      .where('user_id', '=', userId)
      .where('status', '=', 'active');
    if (tenantId) q = q.where('tenant_id', '=', tenantId);
    return q.orderBy('created_at', 'asc').execute();
  });
  if (rows.length === 0) return null;
  if (rows.length > 1 && !tenantId) return null; // several tenants require an explicit choice
  const row = rows[0]!;
  return { tenantId: row.tenant_id, role: coerceRole(row.role) };
}

/**
 * Authorization comes from DB memberships; no active membership = viewer, not an auth failure.
 * `actorId` is the forge user id, matching the webhook actor so console confirmation of comment-triggered plans works.
 */
export async function resolveSessionAuthContext(
  db: Db,
  claims: { userId: string; provider: string; issuer: string; subject: string; login?: string },
  tenantId?: string,
): Promise<AuthContext> {
  const identity = {
    provider: claims.provider,
    issuer: claims.issuer,
    subject: claims.subject,
    ...(claims.login ? { login: claims.login } : {}),
  };
  const membership = await resolveActiveMembership(db, claims.userId, tenantId);
  const base = { actorId: claims.subject, userId: claims.userId, identity };
  if (!membership) return { role: 'viewer', scopes: scopesForRole('viewer'), ...base };
  return { role: membership.role, scopes: scopesForRole(membership.role), tenantId: membership.tenantId, ...base };
}

/** No cookie = anonymous viewer; an invalid or expired cookie throws InvalidTokenError (401). */
export function createSessionAuthResolver(config: { db: Db }): AuthResolver {
  return async (req: FastifyRequest): Promise<AuthContext> => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return ANONYMOUS;
    const claims = await verifySession(token);
    if (!claims) throw new InvalidTokenError();
    return resolveSessionAuthContext(config.db, claims, requestedTenant(req));
  };
}
