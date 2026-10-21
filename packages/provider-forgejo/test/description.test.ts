import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { FakeProviderServer } from '@reviewbot/testkit';
import { ForgejoProvider } from '../src/index.js';

const HOST_ID = '018f9a3c-0000-7000-8000-0000000000c1';
const REPO_ID = '018f9a3c-0000-7000-8000-0000000000c2';

function host(baseUrl: string): ProviderHostRef {
  return { id: HOST_ID, provider: 'forgejo', baseUrl, apiUrl: baseUrl, isSaas: false };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function make(configure: (s: FakeProviderServer) => void): Promise<{ provider: ForgejoProvider; server: FakeProviderServer }> {
  const server = new FakeProviderServer();
  cleanups.push(() => server.close());
  configure(server);
  const url = await server.listen();
  const provider = new ForgejoProvider({ client: new RestClient({ baseUrl: url }), host: host(url), resolveRepo: () => ({ owner: 'acme', repo: 'app' }) });
  return { provider, server };
}

const ref = { id: '', repositoryId: REPO_ID, nativeId: '5001', number: 7, kind: 'pull-request' as const };

describe('Forgejo PR 描述(§25.1 Summary→描述)', () => {
  it('getDescription → PR body', async () => {
    const { provider } = await make((s) =>
      s.on('GET', '/repos/acme/app/pulls/7', { status: 200, body: { id: 5001, number: 7, title: 't', body: '原始 body', state: 'open', user: { id: 1 }, head: { sha: 'a', ref: 'f' }, base: { sha: 'b', ref: 'main' } } }),
    );
    expect(await provider.changes.getDescription!(ref)).toBe('原始 body');
  });

  it('updateDescription → PATCH body', async () => {
    const { provider, server } = await make((s) => s.on('PATCH', '/repos/acme/app/pulls/7', { status: 200, body: {} }));
    await provider.changes.updateDescription!(ref, '新 body');
    const patch = server.requests.find((r) => r.method === 'PATCH');
    expect(patch?.json()).toMatchObject({ body: '新 body' });
  });
});

describe('Forgejo changes.create', () => {
  const repo = { id: REPO_ID, providerHostId: 'h', installationId: 'i', nativeId: '1', namespace: 'acme', name: 'app', cloneUrl: 'x', defaultBranch: 'main' };
  const input = { title: 'winnowl fix', body: { markdown: 'stacked' }, sourceBranch: 'winnowl/42/act', targetBranch: 'feature/x' };

  it('updates the open pull request of the same branch instead of opening a second one', async () => {
    const { provider, server } = await make((s) =>
      s
        .on('GET', '/repos/acme/app/pulls', { status: 200, body: [{ id: 1, number: 2, head: { ref: 'other' } }, { id: 3, number: 4, head: { ref: 'winnowl/42/act' } }] })
        .on('PATCH', '/repos/acme/app/pulls/4', { status: 200, body: {} }),
    );
    expect((await provider.changes.create(repo, input, { key: 'k' })).ref).toMatchObject({ number: 4 });
    expect(server.requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
  });

  it('opens one when no open pull request uses the branch', async () => {
    const { provider } = await make((s) =>
      s.on('GET', '/repos/acme/app/pulls', { status: 200, body: [] }).on('POST', '/repos/acme/app/pulls', { status: 201, body: { id: 5, number: 6 } }),
    );
    expect((await provider.changes.create(repo, input, { key: 'k' })).ref).toMatchObject({ number: 6 });
  });
});

