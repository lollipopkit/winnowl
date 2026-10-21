import type { RepositoryRef } from '@reviewbot/domain';
import { syncInstallationRepositories } from '@reviewbot/provider-sync';
import type { JobHandler } from './supervisor.js';

export interface SyncInstallationPayload {
  tenantId: string;
  providerHostId: string;
  installationNativeId: string;
  internalInstallationId: string;
}

export interface SyncInstallationDeps {
  resolveListRepositories: (
    payload: SyncInstallationPayload,
  ) => (installationNativeId: string) => Promise<RepositoryRef[]>;
}

export function createSyncInstallationHandler(deps: SyncInstallationDeps): JobHandler {
  return async ({ job, db }) => {
    const payload = job.payload as unknown as SyncInstallationPayload;
    await syncInstallationRepositories(db, {
      listRepositories: deps.resolveListRepositories(payload),
      tenantId: payload.tenantId,
      providerHostId: payload.providerHostId,
      installationNativeId: payload.installationNativeId,
      internalInstallationId: payload.internalInstallationId,
    });
  };
}
