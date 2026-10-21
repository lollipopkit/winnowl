import type { Db } from '@reviewbot/db';
import type { RepositoryRef } from '@reviewbot/domain';

/** The `repositories` columns a RepositoryRef is built from. */
export interface RepositoryRow {
  id: string;
  provider_host_id: string;
  installation_id: string;
  native_id: string;
  namespace: string;
  name: string;
  clone_url: string;
  default_branch: string;
}

export function repositoryRefFromRow(row: RepositoryRow): RepositoryRef {
  return {
    id: row.id,
    providerHostId: row.provider_host_id,
    installationId: row.installation_id,
    nativeId: row.native_id,
    namespace: row.namespace,
    name: row.name,
    cloneUrl: row.clone_url,
    defaultBranch: row.default_branch,
  };
}

export async function loadRepositoryRef(db: Db, repositoryId: string): Promise<RepositoryRef> {
  const row = await db.selectFrom('repositories').selectAll().where('id', '=', repositoryId).executeTakeFirstOrThrow();
  return repositoryRefFromRow(row);
}
