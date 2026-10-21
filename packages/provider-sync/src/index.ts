import type { Db } from '@reviewbot/db';
import type { RepositoryRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';

export interface SyncInstallationOptions {
  listRepositories: (installationNativeId: string) => Promise<RepositoryRef[]>;
  tenantId: string;
  providerHostId: string;
  installationNativeId: string;
  internalInstallationId: string;
  now?: () => number;
}

export interface SyncResult {
  synced: number;
  repositoryIds: string[];
}

/** Idempotent on provider_host_id + native_id. */
export async function syncInstallationRepositories(
  db: Db,
  options: SyncInstallationOptions,
): Promise<SyncResult> {
  const now = new Date(options.now?.() ?? Date.now());
  const repos = await options.listRepositories(options.installationNativeId);
  const repositoryIds: string[] = [];

  for (const repo of repos) {
    const row = await db
      .insertInto('repositories')
      .values({
        id: uuidv7(now.getTime()),
        tenant_id: options.tenantId,
        provider_host_id: options.providerHostId,
        installation_id: options.internalInstallationId,
        native_id: repo.nativeId,
        namespace: repo.namespace,
        name: repo.name,
        clone_url: repo.cloneUrl,
        default_branch: repo.defaultBranch,
        visibility: repo.visibility ?? null,
        created_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['provider_host_id', 'native_id']).doUpdateSet({
          namespace: repo.namespace,
          name: repo.name,
          clone_url: repo.cloneUrl,
          default_branch: repo.defaultBranch,
          // Refreshed every sync so a repository made private loses the public discount at once;
          // unknown (null) is billed as private.
          visibility: repo.visibility ?? null,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    repositoryIds.push(row.id);
  }

  return { synced: repositoryIds.length, repositoryIds };
}

export { insertRevision, upsertChangeRequest } from './change-requests.js';
export type { ChangeRequestSnapshot, RevisionSnapshot } from './change-requests.js';
