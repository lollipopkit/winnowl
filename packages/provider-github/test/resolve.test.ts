import { describe, expect, it } from 'vitest';
import type { ProviderHostRef } from '@reviewbot/domain';
import type { RestClient } from '@reviewbot/provider-http';
import { GithubProvider } from '../src/index.js';

const HOST: ProviderHostRef = { id: 'h1', provider: 'github', baseUrl: 'x', apiUrl: 'x', isSaas: true };
const thread = { nativeId: '42', changeRequest: { id: 'cr', repositoryId: 'rp', nativeId: '7', number: 7, kind: 'pull-request' as const } };

interface Call {
  query: string;
  variables: unknown;
}

function graphqlClient(calls: Call[], threads: { id: string; commentDbIds: number[] }[]): RestClient {
  return {
    post: async (_path: string, opts: { body: { query: string; variables: unknown } }) => {
      calls.push({ query: opts.body.query, variables: opts.body.variables });
      const data = opts.body.query.includes('reviewThreads')
        ? {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: threads.map((t) => ({ id: t.id, comments: { nodes: t.commentDbIds.map((d) => ({ databaseId: d })) } })),
                },
              },
            },
          }
        : { resolveReviewThread: { thread: { id: (opts.body.variables as { id: string }).id } } };
      return { status: 200, headers: new Headers(), data: { data }, rateLimit: {} };
    },
  } as unknown as RestClient;
}

describe('GithubProvider.discussions.resolve(GraphQL 线程 resolve)', () => {
  const provider = (c: RestClient) => new GithubProvider({ client: c, host: HOST, resolveRepo: () => ({ owner: 'acme', repo: 'r' }) });

  it('comment databaseId → 线程 node id 映射后 resolveReviewThread', async () => {
    const calls: Call[] = [];
    await provider(graphqlClient(calls, [{ id: 'T_match', commentDbIds: [42] }, { id: 'T_other', commentDbIds: [99] }])).discussions.resolve!(thread);
    expect(calls).toHaveLength(2); // thread query + mutation
    expect(calls[0]!.query).toContain('reviewThreads');
    expect(calls[1]!.query).toContain('resolveReviewThread');
    expect(calls[1]!.variables).toEqual({ id: 'T_match' }); // the thread containing comment 42
  });

  it('无匹配线程(评论已删)→ 幂等静默,不发 mutation', async () => {
    const calls: Call[] = [];
    await provider(graphqlClient(calls, [{ id: 'T_other', commentDbIds: [99] }])).discussions.resolve!(thread);
    expect(calls).toHaveLength(1); // query only, no mutation
  });

  it('unresolve 走 unresolveReviewThread', async () => {
    const calls: Call[] = [];
    await provider(graphqlClient(calls, [{ id: 'T_match', commentDbIds: [42] }])).discussions.unresolve!(thread);
    expect(calls[1]!.query).toContain('unresolveReviewThread');
    expect(calls[1]!.variables).toEqual({ id: 'T_match' });
  });
});
