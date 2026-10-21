import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef, RepositoryRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { FakeProviderServer } from '@reviewbot/testkit';
import { GitlabProvider } from '../src/index.js';

const HOST_ID = '018f9a3c-0000-7000-8000-000000000001';
const REPO_ID = '018f9a3c-0000-7000-8000-000000000002';
const INST_ID = '018f9a3c-0000-7000-8000-000000000003';

function host(baseUrl: string): ProviderHostRef {
  return { id: HOST_ID, provider: 'gitlab', baseUrl, apiUrl: baseUrl, isSaas: true };
}

const repo: RepositoryRef = {
  id: REPO_ID,
  providerHostId: HOST_ID,
  installationId: INST_ID,
  nativeId: '55',
  namespace: 'acme',
  name: 'app',
  cloneUrl: 'https://gitlab.com/acme/app.git',
  defaultBranch: 'main',
};

async function providerWith(accessLevel?: number): Promise<{ provider: GitlabProvider; server: FakeProviderServer; close: () => Promise<void> }> {
  const server = new FakeProviderServer();
  // members/all includes members inherited from groups.
  if (accessLevel !== undefined) server.on('GET', '/projects/55/members/all/77', { body: { access_level: accessLevel } });
  const baseUrl = await server.listen();
  return {
    provider: new GitlabProvider({ client: new RestClient({ baseUrl }), host: host(baseUrl), resolveProject: () => ({ projectId: '55' }) }),
    server,
    close: () => server.close(),
  };
}

describe('gitlab getActorPermission(§26.4;access_level → 归一化档位)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it.each([
    [50, 'admin'],
    [40, 'maintain'],
    [30, 'write'],
    [20, 'triage'],
    [10, 'read'],
    [0, 'none'],
  ])('access_level %i → %s', async (level, expected) => {
    const h = await providerWith(level as number);
    close = h.close;
    expect(await h.provider.repositories.getActorPermission!(repo, { login: 'alice', providerUserId: '77' })).toBe(expected);
  });

  it('404(非成员)→ none', async () => {
    const h = await providerWith();
    close = h.close;
    expect(await h.provider.repositories.getActorPermission!(repo, { login: 'alice', providerUserId: '77' })).toBe('none');
  });

  it('无 providerUserId → none,且不发请求(GitLab 成员查询按数字 id)', async () => {
    const h = await providerWith(40);
    close = h.close;
    expect(await h.provider.repositories.getActorPermission!(repo, { login: 'alice' })).toBe('none');
    expect(h.server.requests).toHaveLength(0);
  });
});
