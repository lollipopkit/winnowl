import { describe, expect, it } from 'vitest';
import type { ProviderHostRef, RepositoryRef } from '@reviewbot/domain';
import type { RestClient } from '@reviewbot/provider-http';
import { GithubProvider } from '../src/index.js';

const HOST: ProviderHostRef = { id: 'h1', provider: 'github', baseUrl: 'x', apiUrl: 'x', isSaas: true };
const REPO = { namespace: 'acme', name: 'r' } as RepositoryRef;
const CR = { id: 'cr', repositoryId: 'rp', nativeId: '7', number: 7, kind: 'pull-request' as const };

function provider(client: Partial<RestClient>) {
  return new GithubProvider({ client: client as RestClient, host: HOST, resolveRepo: () => ({ owner: 'acme', repo: 'r' }) });
}

describe('GithubProvider reviewer 建议 / 请求', () => {
  it('listPathCommitAuthors 按 path+base 查 commits,跳过没绑账号的提交', async () => {
    const calls: unknown[] = [];
    const p = provider({
      get: (async (path: string, opts: unknown) => {
        calls.push({ path, opts });
        return {
          data: [
            { author: { id: 1, login: 'alice', type: 'User' }, commit: { author: { date: '2026-09-01T00:00:00Z' } } },
            { author: null, commit: { author: { date: '2026-08-01T00:00:00Z' } } },
          ],
        };
      }) as RestClient['get'],
    });
    const authors = await p.repositories.listPathCommitAuthors(REPO, 'lib/a.dart', { gitRef: 'base', limit: 20 });
    expect(calls).toEqual([{ path: 'repos/acme/r/commits', opts: { query: { path: 'lib/a.dart', sha: 'base', per_page: 20 } } }]);
    expect(authors).toEqual([{ actor: { providerUserId: '1', login: 'alice', type: 'user' }, committedAt: '2026-09-01T00:00:00Z' }]);
  });

  it('requestReviewers 按 login 提交', async () => {
    const calls: unknown[] = [];
    const p = provider({ post: (async (path: string, opts: unknown) => void calls.push({ path, opts })) as RestClient['post'] });
    await p.changes.requestReviewers(CR, [{ providerUserId: '1', login: 'alice', type: 'user' }]);
    expect(calls).toEqual([{ path: 'repos/acme/r/pulls/7/requested_reviewers', opts: { body: { reviewers: ['alice'] } } }]);
  });
});
