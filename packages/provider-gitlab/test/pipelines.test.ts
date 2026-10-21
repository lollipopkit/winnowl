import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { FakeProviderServer } from '@reviewbot/testkit';
import { GitlabProvider } from '../src/index.js';

const HOST_ID = '018f9a3c-0000-7000-8000-0000000000b1';
const REPO_ID = '018f9a3c-0000-7000-8000-0000000000b2';

function host(baseUrl: string): ProviderHostRef {
  return { id: HOST_ID, provider: 'gitlab', baseUrl, apiUrl: baseUrl, isSaas: true };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function makeProvider(configure: (s: FakeProviderServer) => void): Promise<GitlabProvider> {
  const server = new FakeProviderServer();
  cleanups.push(() => server.close());
  configure(server);
  const url = await server.listen();
  return new GitlabProvider({
    client: new RestClient({ baseUrl: url }),
    host: host(url),
    resolveProject: () => ({ projectId: '55' }),
  });
}

describe('GitLab pipelines 读取', () => {
  it('listRuns → 回填 repositoryId + 终态结论', async () => {
    const provider = await makeProvider((s) =>
      s
        .on('GET', '/projects/55/merge_requests/7', { status: 200, body: { id: 5001, iid: 7 } })
        .on('GET', '/projects/55/merge_requests/7/pipelines', { status: 200, body: [{ id: 900, status: 'failed', sha: 'deadbeef' }] }),
    );
    const runs = await provider.pipelines.listRuns({ id: '', repositoryId: REPO_ID, nativeId: '5001', number: 7, kind: 'merge-request' });
    expect(runs).toEqual([{ ref: { nativeId: '900', repositoryId: REPO_ID }, status: 'failed', headSha: 'deadbeef', conclusion: 'failed' }]);
  });

  it('getJobs → 映射 job(回填 repositoryId,终态 status 即结论)', async () => {
    const provider = await makeProvider((s) =>
      s.on('GET', '/projects/55/pipelines/900/jobs', {
        status: 200,
        body: [
          { id: 7, name: 'build', status: 'failed' },
          { id: 8, name: 'lint', status: 'running' },
        ],
      }),
    );
    const jobs = await provider.pipelines.getJobs({ nativeId: '900', repositoryId: REPO_ID });
    expect(jobs).toEqual([
      { ref: { nativeId: '7', repositoryId: REPO_ID }, name: 'build', status: 'failed', conclusion: 'failed' },
      { ref: { nativeId: '8', repositoryId: REPO_ID }, name: 'lint', status: 'running' },
    ]);
  });

  it('getLogs → job trace 原文', async () => {
    const provider = await makeProvider((s) =>
      s.on('GET', '/projects/55/jobs/7/trace', { status: 200, body: 'src/app.ts:1:1: error boom' }),
    );
    const logs = await provider.pipelines.getLogs({ nativeId: '7', repositoryId: REPO_ID });
    expect(logs.text).toContain('error boom');
    expect(logs.truncated).toBe(false);
  });

  it('getJobs 缺 repositoryId → 抛错(需坐标)', async () => {
    const provider = await makeProvider(() => undefined);
    await expect(provider.pipelines.getJobs({ nativeId: '900' })).rejects.toThrow(/repositoryId/);
  });
});

describe('GitLab MR 描述(§25.1 Summary→描述)', () => {
  const ref = { id: '', repositoryId: REPO_ID, nativeId: '5001', number: 7, kind: 'merge-request' as const };

  it('getDescription → MR description', async () => {
    const provider = await makeProvider((s) =>
      s.on('GET', '/projects/55/merge_requests/7', { status: 200, body: { id: 5001, iid: 7, description: '原始描述' } }),
    );
    expect(await provider.changes.getDescription!(ref)).toBe('原始描述');
  });

  it('updateDescription → PUT description', async () => {
    const server = new FakeProviderServer();
    cleanups.push(() => server.close());
    server.on('PUT', '/projects/55/merge_requests/7', { status: 200, body: {} });
    const url = await server.listen();
    const provider = new GitlabProvider({ client: new RestClient({ baseUrl: url }), host: host(url), resolveProject: () => ({ projectId: '55' }) });
    await provider.changes.updateDescription!(ref, '新描述');
    const put = server.requests.find((r) => r.method === 'PUT');
    expect(put?.json()).toMatchObject({ description: '新描述' });
  });
});

describe('GitLab changes.create', () => {
  const repo = { id: REPO_ID, providerHostId: 'h', installationId: 'i', nativeId: '55', namespace: 'acme', name: 'app', cloneUrl: 'x', defaultBranch: 'main' };
  const input = { title: 'winnowl fix', body: { markdown: 'stacked' }, sourceBranch: 'winnowl/42/act', targetBranch: 'feature/x' };

  it('opens a merge request when none is open for the branch', async () => {
    const provider = await makeProvider((s) =>
      s.on('GET', '/projects/55/merge_requests', { status: 200, body: [] }).on('POST', '/projects/55/merge_requests', { status: 201, body: { id: 9, iid: 4, web_url: 'https://gl/mr/4' } }),
    );
    expect((await provider.changes.create(repo, input, { key: 'k' })).ref).toMatchObject({ number: 4, kind: 'merge-request' });
  });

  it('updates the open merge request of the same branch instead of failing', async () => {
    let server!: FakeProviderServer;
    const provider = await makeProvider((s) => {
      server = s;
      s.on('GET', '/projects/55/merge_requests', { status: 200, body: [{ id: 9, iid: 4 }] }).on('PUT', '/projects/55/merge_requests/4', { status: 200, body: {} });
    });
    expect((await provider.changes.create(repo, input, { key: 'k' })).ref).toMatchObject({ number: 4 });
    expect(server.requests.map((r) => r.method)).toEqual(['GET', 'PUT']);
    expect(server.requests[0]!.url).toContain('source_branch=winnowl%2F42%2Fact');
  });
});

