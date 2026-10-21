import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { decryptEnvelope, encryptEnvelope, type EncryptedEnvelope, type MasterKeyProvider } from '@reviewbot/kms';
import { PLUGIN_MANIFEST, type PluginName } from './registry.js';

/**
 * Plugin service API keys at org / repo / user scope (repo and user are mutually exclusive),
 * KMS envelope encrypted; listings return only redacted metadata.
 * TODO: wire user-scope keys into user-initiated conversation runs.
 */

export function isKnownService(service: string): service is PluginName {
  return PLUGIN_MANIFEST.some((m) => m.name === service);
}

export interface ServiceCredentialScope {
  tenantId: string;
  repositoryId?: string;
  /** Mutually exclusive with repositoryId. */
  userId?: string;
}

export type StorableService = PluginName | 'llm';

export interface StoreServiceCredentialInput extends ServiceCredentialScope {
  service: StorableService;
  apiKey: string;
  now?: number;
}

export async function storeServiceCredential(db: Db, kek: MasterKeyProvider, input: StoreServiceCredentialInput): Promise<void> {
  if (input.repositoryId && input.userId) throw new Error('service credential: repositoryId 与 userId 互斥(一条凭据只属一级)');
  const envelope = (await encryptEnvelope(input.apiKey, kek)) as unknown as Record<string, unknown>;
  const now = new Date(input.now ?? Date.now());
  // The onConflict target must match the partial unique index's columns and predicate for Postgres to infer it.
  await db
    .insertInto('service_credentials')
    .values({
      id: uuidv7(input.now),
      tenant_id: input.tenantId,
      repository_id: input.repositoryId ?? null,
      user_id: input.userId ?? null,
      service: input.service,
      envelope,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => {
      if (input.repositoryId) {
        return oc.columns(['tenant_id', 'repository_id', 'service']).where('repository_id', 'is not', null).doUpdateSet({ envelope, updated_at: now });
      }
      if (input.userId) {
        return oc.columns(['tenant_id', 'user_id', 'service']).where('user_id', 'is not', null).doUpdateSet({ envelope, updated_at: now });
      }
      return oc
        .columns(['tenant_id', 'service'])
        .where('repository_id', 'is', null)
        .where('user_id', 'is', null)
        .doUpdateSet({ envelope, updated_at: now });
    })
    .execute();
}

export async function deleteServiceCredential(db: Db, input: ServiceCredentialScope & { service: StorableService }): Promise<void> {
  await db
    .deleteFrom('service_credentials')
    .where('tenant_id', '=', input.tenantId)
    .where('service', '=', input.service)
    .where('repository_id', input.repositoryId ? '=' : 'is', input.repositoryId ?? null)
    .where('user_id', input.userId ? '=' : 'is', input.userId ?? null)
    .execute();
}

export interface ServiceCredentialMeta {
  service: string;
  scope: 'org' | 'repo' | 'user';
  repositoryId: string | null;
  userId: string | null;
  updatedAt: Date;
}

/** Redacted metadata only; never the envelope or plaintext. */
export async function listServiceCredentials(db: Db, tenantId: string): Promise<ServiceCredentialMeta[]> {
  const rows = await db
    .selectFrom('service_credentials')
    .select(['service', 'repository_id', 'user_id', 'updated_at'])
    .where('tenant_id', '=', tenantId)
    .orderBy('service')
    .execute();
  return rows.map((r) => ({
    service: r.service,
    scope: r.repository_id ? 'repo' : r.user_id ? 'user' : 'org',
    repositoryId: r.repository_id,
    userId: r.user_id,
    updatedAt: r.updated_at,
  }));
}

/** Most specific key per service: user > repo > org; the user level only when `userId` is given. */
export async function resolveServiceCredentials(
  db: Db,
  kek: MasterKeyProvider,
  scope: { tenantId: string; repositoryId: string; userId?: string },
): Promise<Partial<Record<PluginName, string>>> {
  const rows = await db
    .selectFrom('service_credentials')
    .select(['service', 'repository_id', 'user_id', 'envelope'])
    .where('tenant_id', '=', scope.tenantId)
    .where((eb) =>
      eb.or([
        eb.and([eb('user_id', 'is', null), eb('repository_id', 'is', null)]),
        eb.and([eb('user_id', 'is', null), eb('repository_id', '=', scope.repositoryId)]),
        ...(scope.userId ? [eb('user_id', '=', scope.userId)] : []),
      ]),
    )
    .execute();
  const out: Partial<Record<PluginName, string>> = {};
  const rank = (r: { repository_id: string | null; user_id: string | null }): number => (r.user_id ? 2 : r.repository_id ? 1 : 0);
  for (const r of [...rows].sort((a, b) => rank(a) - rank(b))) {
    if (!isKnownService(r.service)) continue;
    out[r.service] = (await decryptEnvelope(r.envelope as unknown as EncryptedEnvelope, kek)).toString('utf8');
  }
  return out;
}
