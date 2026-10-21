import type { Db } from '@reviewbot/db';
import type { ProviderHostRef, ProviderKind, RepositoryRef } from '@reviewbot/domain';
import { guardMentions, type SourceControlProvider } from '@reviewbot/provider-contracts';
import { ForgejoProvider, type FjRepoCoords } from '@reviewbot/provider-forgejo';
import { GitHubAppAuth, GithubProvider, type GhRepoCoords } from '@reviewbot/provider-github';
import { GitlabProvider, type GlProjectCoords } from '@reviewbot/provider-gitlab';
import { RestClient } from '@reviewbot/provider-http';
import type { ProviderCredentialStore } from './store.js';

export interface ProviderFactoryDeps {
  db: Db;
  store: ProviderCredentialStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function createSourceProviderForInstallation(
  deps: ProviderFactoryDeps,
  internalInstallationId: string,
): Promise<SourceControlProvider> {
  return guardMentions(await createRawProvider(deps, internalInstallationId));
}

async function createRawProvider(deps: ProviderFactoryDeps, internalInstallationId: string): Promise<SourceControlProvider> {
  const inst = await deps.db
    .selectFrom('installations')
    .select(['provider_host_id', 'native_id'])
    .where('id', '=', internalInstallationId)
    .executeTakeFirst();
  if (!inst) throw new Error(`installation not found: ${internalInstallationId}`);

  const host = await deps.db
    .selectFrom('provider_hosts')
    .select(['id', 'provider', 'base_url', 'api_url', 'is_saas'])
    .where('id', '=', inst.provider_host_id)
    .executeTakeFirstOrThrow();

  const hostRef: ProviderHostRef = {
    id: host.id,
    provider: host.provider as ProviderKind,
    baseUrl: host.base_url,
    apiUrl: host.api_url,
    isSaas: host.is_saas,
  };

  if (host.provider === 'github') {
    const creds = await deps.store.githubAppCredentials(host.id);
    if (!creds) throw new Error(`no github app credentials for host ${host.id}`);

    const unauthed = new RestClient({ baseUrl: host.api_url, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    const auth = new GitHubAppAuth({
      appId: creds.appId,
      privateKeyPem: creds.privateKeyPem,
      installationId: inst.native_id,
      client: unauthed,
      ...(deps.now ? { now: deps.now } : {}),
    });
    const authed = new RestClient({
      baseUrl: host.api_url,
      authorization: auth.authorization(),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    return new GithubProvider({
      client: authed,
      host: hostRef,
      resolveRepo: makeResolveRepo(deps.db),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  if (host.provider === 'gitlab') {
    const token = await deps.store.token(host.id);
    if (!token) throw new Error(`no token for host ${host.id}`);
    const client = new RestClient({ baseUrl: host.api_url, authorization: () => `Bearer ${token}`, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    return new GitlabProvider({ client, host: hostRef, resolveProject: makeResolveProject(deps.db), ...(deps.now ? { now: deps.now } : {}) });
  }

  if (host.provider === 'forgejo') {
    const token = await deps.store.token(host.id);
    if (!token) throw new Error(`no token for host ${host.id}`);
    const client = new RestClient({ baseUrl: host.api_url, authorization: () => `token ${token}`, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    return new ForgejoProvider({ client, host: hostRef, resolveRepo: makeResolveRepoFj(deps.db), ...(deps.now ? { now: deps.now } : {}) });
  }

  throw new Error(`provider not yet supported by factory: ${host.provider}`);
}

/** Control-plane only: the token must never be logged or enter a sandbox unscoped. */
export async function getInstallationToken(
  deps: ProviderFactoryDeps,
  internalInstallationId: string,
  /** Anything handed to a sandbox host must be scoped: read-only, one repository. */
  scope?: { repositoryNativeIds: string[]; permissions: Record<string, 'read' | 'write'> },
): Promise<string> {
  const inst = await deps.db
    .selectFrom('installations')
    .select(['provider_host_id', 'native_id'])
    .where('id', '=', internalInstallationId)
    .executeTakeFirst();
  if (!inst) throw new Error(`installation not found: ${internalInstallationId}`);
  const host = await deps.db
    .selectFrom('provider_hosts')
    .select(['id', 'provider', 'api_url'])
    .where('id', '=', inst.provider_host_id)
    .executeTakeFirstOrThrow();
  if (host.provider !== 'github') throw new Error(`installation token not supported for provider: ${host.provider}`);
  const creds = await deps.store.githubAppCredentials(host.id);
  if (!creds) throw new Error(`no github app credentials for host ${host.id}`);
  const client = new RestClient({ baseUrl: host.api_url, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  const auth = new GitHubAppAuth({
    appId: creds.appId,
    privateKeyPem: creds.privateKeyPem,
    installationId: inst.native_id,
    client,
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!scope) return auth.installationToken();
  return auth.scopedInstallationToken({
    repositoryIds: scope.repositoryNativeIds.map((id) => {
      const n = Number(id);
      if (!Number.isSafeInteger(n)) throw new Error(`not a GitHub repository id: ${id}`);
      return n;
    }),
    permissions: scope.permissions,
  });
}

function makeResolveRepo(db: Db): (repositoryId: string) => Promise<GhRepoCoords> {
  return async (repositoryId: string): Promise<GhRepoCoords> => {
    const repo = await db
      .selectFrom('repositories')
      .select(['namespace', 'name'])
      .where('id', '=', repositoryId)
      .executeTakeFirstOrThrow();
    return { owner: repo.namespace, repo: repo.name };
  };
}

/** GitLab project id = native_id. */
function makeResolveProject(db: Db): (repositoryId: string) => Promise<GlProjectCoords> {
  return async (repositoryId: string): Promise<GlProjectCoords> => {
    const repo = await db.selectFrom('repositories').select(['native_id']).where('id', '=', repositoryId).executeTakeFirstOrThrow();
    return { projectId: repo.native_id };
  };
}

function makeResolveRepoFj(db: Db): (repositoryId: string) => Promise<FjRepoCoords> {
  return async (repositoryId: string): Promise<FjRepoCoords> => {
    const repo = await db.selectFrom('repositories').select(['namespace', 'name']).where('id', '=', repositoryId).executeTakeFirstOrThrow();
    return { owner: repo.namespace, repo: repo.name };
  };
}

/** Payload shape matches runner-supervisor's SyncInstallationPayload. */
export function createResolveListRepositories(
  deps: ProviderFactoryDeps,
): (payload: { internalInstallationId: string }) => (installationNativeId: string) => Promise<RepositoryRef[]> {
  return (payload) => async (installationNativeId) => {
    const provider = await createSourceProviderForInstallation(deps, payload.internalInstallationId);
    return provider.repositories.listForInstallation(installationNativeId);
  };
}
