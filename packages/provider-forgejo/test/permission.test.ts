import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef, RepositoryRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { FakeProviderServer } from '@reviewbot/testkit';
import { ForgejoProvider } from '../src/index.js';

const HOST_ID = '018f9a3c-0000-7000-8000-000000000001';
const REPO_ID = '018f9a3c-0000-7000-8000-000000000002';
const INST_ID = '018f9a3c-0000-7000-8000-000000000003';

function host(baseUrl: string): ProviderHostRef {
  return { id: HOST_ID, provider: 'forgejo', baseUrl, apiUrl: baseUrl, isSaas: false };
}

const repo: RepositoryRef = {
  id: REPO_ID,
  providerHostId: HOST_ID,
  installationId: INST_ID,
  nativeId: '900',
  namespace: 'acme',
  name: 'app',
  cloneUrl: 'https://forge.acme.com/acme/app.git',
  defaultBranch: 'main',
};

async function providerWith(permission?: string): Promise<{ provider: ForgejoProvider; close: () => Promise<void> }> {
  const server = new FakeProviderServer();
  if (permission !== undefined) server.on('GET', '/repos/acme/app/collaborators/alice/permission', { body: { permission } });
  const baseUrl = await server.listen();
  return {
    provider: new ForgejoProvider({ client: new RestClient({ baseUrl }), host: host(baseUrl), resolveRepo: () => ({ owner: 'acme', repo: 'app' }) }),
    close: () => server.close(),
  };
}

describe('forgejo getActorPermission(§26.4;只有 admin/write/read/none 四档)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it.each([
    ['owner', 'admin'],
    ['admin', 'admin'],
    ['write', 'write'],
    ['read', 'read'],
    ['none', 'none'],
  ])('permission=%s → %s', async (permission, expected) => {
    const h = await providerWith(permission as string);
    close = h.close;
    expect(await h.provider.repositories.getActorPermission!(repo, { login: 'alice' })).toBe(expected);
  });

  it('404(非协作者)→ none', async () => {
    const h = await providerWith();
    close = h.close;
    expect(await h.provider.repositories.getActorPermission!(repo, { login: 'alice' })).toBe('none');
  });
});
