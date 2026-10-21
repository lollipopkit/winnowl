import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef, RepositoryRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { FakeProviderServer } from '@reviewbot/testkit';
import { GithubProvider } from '../src/index.js';

const HOST: Omit<ProviderHostRef, 'baseUrl' | 'apiUrl'> = { id: 'h', provider: 'github', isSaas: true };
const REPO: RepositoryRef = {
  id: 'r',
  providerHostId: 'h',
  installationId: 'i',
  nativeId: '1',
  namespace: 'acme',
  name: 'app',
  cloneUrl: 'https://github.com/acme/app.git',
  defaultBranch: 'main',
};

const servers: FakeProviderServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function provider(branchExists: boolean): Promise<{ gh: GithubProvider; server: FakeProviderServer }> {
  const server = new FakeProviderServer();
  servers.push(server);
  server
    .on('GET', '/repos/acme/app/git/commits/base', { status: 200, body: { sha: 'base', tree: { sha: 'base-tree' } } })
    .on('POST', '/repos/acme/app/git/blobs', { status: 201, body: { sha: 'blob-1' } })
    .on('POST', '/repos/acme/app/git/trees', { status: 201, body: { sha: 'new-tree' } })
    .on('POST', '/repos/acme/app/git/commits', { status: 201, body: { sha: 'new-commit' } })
    .on('PATCH', '/repos/acme/app/git/refs/heads/winnowl/7/a', branchExists
      ? { status: 200, body: { object: { sha: 'new-commit' } } }
      : { status: 422, body: { message: 'Reference does not exist' } })
    .on('POST', '/repos/acme/app/git/refs', { status: 201, body: { ref: 'refs/heads/winnowl/7/a' } });
  const url = await server.listen();
  const gh = new GithubProvider({
    client: new RestClient({ baseUrl: url }),
    host: { ...HOST, baseUrl: url, apiUrl: url },
    resolveRepo: () => ({ owner: 'acme', repo: 'app' }),
  });
  return { gh, server };
}

const input = {
  baseSha: 'base',
  branch: 'winnowl/7/a',
  message: 'winnowl: fix',
  author: { name: 'winnowl', email: 'bot@example.com' },
  changes: [
    { path: 'src/a.ts', mode: '100644' as const, contentBase64: Buffer.from('x\n').toString('base64') },
    { path: 'old.txt', deleted: true as const },
  ],
};

describe('GitHub commits through the Git Data API (no clone, write token stays on the control plane)', () => {
  it('blobs → tree on the base tree → commit on base → creates a missing bot branch', async () => {
    const { gh, server } = await provider(false);
    expect(await gh.commits.commitChanges(REPO, input)).toBe('new-commit');
    const calls = server.requests.map((r) => `${r.method} ${r.url}`);
    expect(calls).toEqual([
      'GET /repos/acme/app/git/commits/base',
      'POST /repos/acme/app/git/blobs',
      'POST /repos/acme/app/git/trees',
      'POST /repos/acme/app/git/commits',
      'PATCH /repos/acme/app/git/refs/heads/winnowl/7/a',
      'POST /repos/acme/app/git/refs',
    ]);
    const body = (i: number) => server.requests[i]!.json();
    expect(body(1)).toEqual({ content: input.changes[0]!.contentBase64, encoding: 'base64' });
    expect(body(2)).toEqual({
      base_tree: 'base-tree',
      tree: [
        { path: 'src/a.ts', mode: '100644', type: 'blob', sha: 'blob-1' },
        { path: 'old.txt', mode: '100644', type: 'blob', sha: null },
      ],
    });
    expect(body(3)).toEqual({ message: 'winnowl: fix', tree: 'new-tree', parents: ['base'], author: input.author });
    expect(body(5)).toEqual({ ref: 'refs/heads/winnowl/7/a', sha: 'new-commit' });
  });

  it('moves an existing bot branch (a rerun replaces its own earlier fix)', async () => {
    const { gh, server } = await provider(true);
    await gh.commits.commitChanges(REPO, input);
    expect(server.requests.at(-1)).toMatchObject({ method: 'PATCH', url: '/repos/acme/app/git/refs/heads/winnowl/7/a' });
    expect(server.requests.at(-1)!.json()).toEqual({ sha: 'new-commit', force: true });
  });
});
