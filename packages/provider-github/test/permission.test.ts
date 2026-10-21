import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef, RepositoryRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { FakeProviderServer } from '@reviewbot/testkit';
import { GithubProvider } from '../src/index.js';

const HOST_ID = '018f9a3c-0000-7000-8000-000000000001';
const REPO_ID = '018f9a3c-0000-7000-8000-000000000002';
const INST_ID = '018f9a3c-0000-7000-8000-000000000003';

function host(baseUrl: string): ProviderHostRef {
  return { id: HOST_ID, provider: 'github', baseUrl, apiUrl: baseUrl, isSaas: true };
}

const repo: RepositoryRef = {
  id: REPO_ID,
  providerHostId: HOST_ID,
  installationId: INST_ID,
  nativeId: '900',
  namespace: 'acme',
  name: 'app',
  cloneUrl: 'https://github.com/acme/app.git',
  defaultBranch: 'main',
};

/** Fake server with only the given responses; other paths 404. */
async function providerWith(response?: { permission?: string; role_name?: string }): Promise<{ provider: GithubProvider; close: () => Promise<void> }> {
  const server = new FakeProviderServer();
  if (response) server.on('GET', '/repos/acme/app/collaborators/alice/permission', { body: response });
  const baseUrl = await server.listen();
  return {
    provider: new GithubProvider({ client: new RestClient({ baseUrl }), host: host(baseUrl), resolveRepo: () => ({ owner: 'acme', repo: 'app' }) }),
    close: () => server.close(),
  };
}

describe('github getActorPermission(§26.4 ignore/pause 授权)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('role_name 优先:maintain/triage 两档只在 role_name 里有', async () => {
    const h = await providerWith({ permission: 'write', role_name: 'maintain' });
    close = h.close;
    expect(await h.provider.repositories.getActorPermission!(repo, { login: 'alice' })).toBe('maintain');
  });

  it('无 role_name → 退回 permission(push/pull 老字段也认)', async () => {
    const h = await providerWith({ permission: 'push' });
    close = h.close;
    expect(await h.provider.repositories.getActorPermission!(repo, { login: 'alice' })).toBe('write');
  });

  it('permission=none → none', async () => {
    const h = await providerWith({ permission: 'none', role_name: 'none' });
    close = h.close;
    expect(await h.provider.repositories.getActorPermission!(repo, { login: 'alice' })).toBe('none');
  });

  it('404(非协作者)→ none,不抛', async () => {
    const h = await providerWith();
    close = h.close;
    expect(await h.provider.repositories.getActorPermission!(repo, { login: 'alice' })).toBe('none');
  });
});
