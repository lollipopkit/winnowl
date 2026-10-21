import { uuidv7 } from '@reviewbot/ids';
import { providerIssuer } from '@reviewbot/domain';
import type { Db } from '@reviewbot/db';

export interface ProvisionInput {
  provider: string; // github|gitlab|forgejo
  host: { baseUrl: string; apiUrl: string; isSaas: boolean };
  installationNativeId: string;
  accountLogin: string;
  installer: { providerUserId: string; login: string; email?: string };
  tenantName?: string;
  now?: number;
}

export interface ProvisionResult {
  tenantId: string;
  userId: string;
  installationId: string;
  /** false = the installation already existed. */
  created: boolean;
}

/**
 * Resolves a forge identity to a platform user, creating it on first sight.
 * Keyed by host origin, not provider name: user 1 on two Forgejo hosts are different people.
 */
async function resolveOrCreateProviderUser(
  db: Db,
  provider: string,
  issuer: string,
  installer: { providerUserId: string; login: string; email?: string },
  now: Date,
): Promise<string> {
  const found = await db
    .selectFrom('user_identities')
    .select('user_id')
    .where('kind', '=', 'provider')
    .where('issuer', '=', issuer)
    .where('subject', '=', installer.providerUserId)
    .executeTakeFirst();
  if (found) return found.user_id;

  const email = installer.email ?? `${provider}:${installer.login}@provider.local`;
  const userId = uuidv7(now.getTime());
  await db
    .insertInto('users')
    .values({ id: userId, email, display_name: installer.login, created_at: now })
    .onConflict((oc) => oc.column('email').doNothing())
    .execute();
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirstOrThrow();
  await db
    .insertInto('user_identities')
    .values({
      id: uuidv7(now.getTime()),
      user_id: user.id,
      kind: 'provider',
      issuer,
      subject: installer.providerUserId,
      login: installer.login,
      provider,
      tenant_id: null,
      created_at: now,
    })
    .onConflict((oc) => oc.columns(['kind', 'issuer', 'subject']).doNothing())
    .execute();
  const linked = await db
    .selectFrom('user_identities')
    .select('user_id')
    .where('kind', '=', 'provider')
    .where('issuer', '=', issuer)
    .where('subject', '=', installer.providerUserId)
    .executeTakeFirstOrThrow();
  return linked.user_id;
}

/** Provisions a tenant for an App installation. Idempotent per provider + installation native_id. */
export async function provisionTenant(db: Db, input: ProvisionInput): Promise<ProvisionResult> {
  return db.transaction().execute((trx) => provisionTenantInTransaction(trx, input));
}

/** Same provisioning operation for callers that must compose it with another locked row. */
export async function provisionTenantInTransaction(
  db: Db,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const nowMs = input.now ?? Date.now();
  const now = new Date(nowMs);

  const existing = await db
    .selectFrom('installations')
    .innerJoin('provider_hosts', 'provider_hosts.id', 'installations.provider_host_id')
    .select(['installations.id as id', 'installations.tenant_id as tenantId'])
    .where('provider_hosts.provider', '=', input.provider)
    .where('installations.native_id', '=', input.installationNativeId)
    .executeTakeFirst();
  if (existing) {
    const userId = await resolveOrCreateProviderUser(
      db,
      input.provider,
      providerIssuer(input.provider, input.host.baseUrl),
      input.installer,
      now,
    );
    return { tenantId: existing.tenantId, userId, installationId: existing.id, created: false };
  }

  // Installer identity is keyed by this host's origin (fixed for SaaS, base_url for self-hosted).
  const userId = await resolveOrCreateProviderUser(
    db,
    input.provider,
    providerIssuer(input.provider, input.host.baseUrl),
    input.installer,
    now,
  );
  const tenantId = uuidv7(nowMs);
  const providerHostId = uuidv7(nowMs);
  const installationId = uuidv7(nowMs);

  await db
    .insertInto('tenants')
    .values({
      id: tenantId,
      name: input.tenantName ?? input.accountLogin,
      region: null,
      created_at: now,
    })
    .execute();
  await db
    .insertInto('provider_hosts')
    .values({
      id: providerHostId,
      tenant_id: tenantId,
      provider: input.provider,
      base_url: input.host.baseUrl,
      api_url: input.host.apiUrl,
      is_saas: input.host.isSaas,
      created_at: now,
    })
    .execute();
  await db
    .insertInto('memberships')
    .values({
      id: uuidv7(nowMs),
      tenant_id: tenantId,
      user_id: userId,
      role: 'owner',
      status: 'active',
      created_at: now,
    })
    .execute();
  await db
    .insertInto('installations')
    .values({
      id: installationId,
      tenant_id: tenantId,
      provider_host_id: providerHostId,
      native_id: input.installationNativeId,
      account_login: input.accountLogin,
      status: 'active',
      created_at: now,
    })
    .execute();
  const free = await db
    .selectFrom('plans')
    .select('id')
    .where('key', '=', 'free')
    .where('active', '=', true)
    .executeTakeFirst();
  if (free) {
    await db
      .insertInto('subscriptions')
      .values({
        id: uuidv7(nowMs),
        tenant_id: tenantId,
        plan_id: free.id,
        status: 'active',
        // Out of quota = stop; degrade would keep accruing cost on the cheap tier.
        overage_policy: 'reject',
        current_period_start: now,
        current_period_end: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  return { tenantId, userId, installationId, created: true };
}
