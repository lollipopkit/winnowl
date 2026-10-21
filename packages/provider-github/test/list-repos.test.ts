import { describe, expect, it } from 'vitest';
import type { ProviderHostRef } from '@reviewbot/domain';
import type { RestClient } from '@reviewbot/provider-http';
import { GithubProvider } from '../src/index.js';

const HOST: ProviderHostRef = { id: 'h1', provider: 'github', baseUrl: 'x', apiUrl: 'x', isSaas: true };

function repo(id: number) {
  return { id, name: `r${id}`, default_branch: 'main', clone_url: `https://github.com/acme/r${id}.git`, owner: { login: 'acme' } };
}

function pagedClient(total: number): { client: RestClient; pages: number[] } {
  const pages: number[] = [];
  const client = {
    get: async (_path: string, opts: { query?: { per_page?: number; page?: number } } = {}) => {
      const per = opts.query?.per_page ?? 100;
      const page = opts.query?.page ?? 1;
      pages.push(page);
      const start = (page - 1) * per;
      const slice = Array.from({ length: Math.max(0, Math.min(per, total - start)) }, (_, i) => repo(start + i + 1));
      return { status: 200, headers: new Headers(), data: { total_count: total, repositories: slice }, rateLimit: {} };
    },
  } as unknown as RestClient;
  return { client, pages };
}

describe('GithubProvider.repositories.listForInstallation 分页', () => {
  it('>100 仓 → 翻页取全量(此前只取第 1 页,漏其余)', async () => {
    const { client, pages } = pagedClient(238);
    const provider = new GithubProvider({ client, host: HOST, resolveRepo: () => ({ owner: 'acme', repo: 'x' }) });
    const repos = await provider.repositories.listForInstallation('inst-1');
    expect(repos).toHaveLength(238);
    expect(pages).toEqual([1, 2, 3]); // 100+100+38
    expect(repos[0]!.nativeId).toBe('1');
    expect(repos[237]!.nativeId).toBe('238');
  });

  it('恰满一页(100)→ 再请求下一页确认为空后停', async () => {
    const { client, pages } = pagedClient(100);
    const provider = new GithubProvider({ client, host: HOST, resolveRepo: () => ({ owner: 'acme', repo: 'x' }) });
    const repos = await provider.repositories.listForInstallation('inst-1');
    expect(repos).toHaveLength(100);
    // total_count=100 reached after page 1: no further request.
    expect(pages).toEqual([1]);
  });

  it('单页(<100)→ 一次请求', async () => {
    const { client, pages } = pagedClient(2);
    const provider = new GithubProvider({ client, host: HOST, resolveRepo: () => ({ owner: 'acme', repo: 'x' }) });
    expect(await provider.repositories.listForInstallation('inst-1')).toHaveLength(2);
    expect(pages).toEqual([1]);
  });
});
