import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { FakeProviderServer } from '@reviewbot/testkit';
import { GithubProvider } from '../src/index.js';

const HOST_ID = '018f9a3c-0000-7000-8000-000000000001';
const REPO_ID = '018f9a3c-0000-7000-8000-000000000002';

function host(baseUrl: string): ProviderHostRef {
  return { id: HOST_ID, provider: 'github', baseUrl, apiUrl: baseUrl, isSaas: true };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function makeProvider(configure: (s: FakeProviderServer) => void): Promise<GithubProvider> {
  const server = new FakeProviderServer();
  cleanups.push(() => server.close());
  configure(server);
  const url = await server.listen();
  return new GithubProvider({
    client: new RestClient({ baseUrl: url }),
    host: host(url),
    resolveRepo: () => ({ owner: 'acme', repo: 'app' }),
  });
}

describe('GitHub pipelines 读取', () => {
  it('getJobs → 映射 job(回填 repositoryId)', async () => {
    const provider = await makeProvider((s) =>
      s.on('GET', '/repos/acme/app/actions/runs/run1/jobs', {
        status: 200,
        body: { jobs: [{ id: 7, name: 'build', status: 'completed', conclusion: 'failure' }] },
      }),
    );
    const jobs = await provider.pipelines.getJobs({ nativeId: 'run1', repositoryId: REPO_ID });
    expect(jobs).toEqual([{ ref: { nativeId: '7', repositoryId: REPO_ID }, name: 'build', status: 'completed', conclusion: 'failure' }]);
  });

  it('getLogs → 原文文本', async () => {
    const provider = await makeProvider((s) =>
      s.on('GET', '/repos/acme/app/actions/jobs/7/logs', { status: 200, body: 'src/app.ts(1,1): error TS1: boom' }),
    );
    const logs = await provider.pipelines.getLogs({ nativeId: '7', repositoryId: REPO_ID });
    expect(logs.text).toContain('error TS1');
    expect(logs.truncated).toBe(false);
  });

  it('getJobs 缺 repositoryId → 抛错(需坐标)', async () => {
    const provider = await makeProvider(() => undefined);
    await expect(provider.pipelines.getJobs({ nativeId: 'run1' })).rejects.toThrow(/repositoryId/);
  });
});

describe('GitHub issues.get', () => {
  it('读取 Issue 标题/正文/标签', async () => {
    const provider = await makeProvider((s) =>
      s.on('GET', '/repos/acme/app/issues/8', {
        status: 200,
        body: { id: 321, number: 8, title: 'Crash', body: 'repro', state: 'open', labels: [{ name: 'bug' }, 'triage'] },
      }),
    );
    const issue = await provider.issues.get({ id: REPO_ID, providerHostId: 'h', installationId: 'i', nativeId: '900', namespace: 'acme', name: 'app', cloneUrl: 'x', defaultBranch: 'main' }, 8);
    expect(issue).toEqual({ nativeId: '321', number: 8, title: 'Crash', body: 'repro', state: 'open', labels: ['bug', 'triage'] });
  });
});

describe('GitHub changes.create', () => {
  it('开 PR(head=bot 分支,base=目标分支)→ 返回 CR ref', async () => {
    const provider = await makeProvider((s) =>
      s
        .on('GET', '/repos/acme/app/pulls', { status: 200, body: [] })
        .on('POST', '/repos/acme/app/pulls', { status: 201, body: { id: 5100, number: 43, html_url: 'https://github.com/acme/app/pull/43' } }),
    );
    const repo = { id: REPO_ID, providerHostId: 'h', installationId: 'i', nativeId: '900', namespace: 'acme', name: 'app', cloneUrl: 'x', defaultBranch: 'main' };
    const receipt = await provider.changes.create(repo, { title: 'winnowl fix', body: { markdown: 'stacked on #42' }, sourceBranch: 'winnowl/42/act', targetBranch: 'feature/x' }, { key: 'k' });
    expect(receipt.ref).toMatchObject({ nativeId: '5100', number: 43, kind: 'pull-request', repositoryId: REPO_ID });
    expect(receipt.url).toContain('/pull/43');
  });

  it('a second delivery of the same branch updates the open PR instead of failing', async () => {
    let server!: FakeProviderServer;
    const provider = await makeProvider((s) => {
      server = s;
      s.on('GET', '/repos/acme/app/pulls', { status: 200, body: [{ id: 5100, number: 43, html_url: 'https://github.com/acme/app/pull/43' }] }).on(
        'PATCH',
        '/repos/acme/app/pulls/43',
        { status: 200, body: {} },
      );
    });
    const repo = { id: REPO_ID, providerHostId: 'h', installationId: 'i', nativeId: '900', namespace: 'acme', name: 'app', cloneUrl: 'x', defaultBranch: 'main' };
    const receipt = await provider.changes.create(repo, { title: 'winnowl fix v2', body: { markdown: 'again' }, sourceBranch: 'winnowl/42/act', targetBranch: 'feature/x' }, { key: 'k' });
    expect(receipt.ref).toMatchObject({ number: 43 });
    expect(server.requests.map((r) => `${r.method} ${r.url.split('?')[0]}`)).toEqual(['GET /repos/acme/app/pulls', 'PATCH /repos/acme/app/pulls/43']);
    expect(server.requests[0]!.url).toContain('head=acme%3Awinnowl%2F42%2Fact');
  });
});

describe('GitHub pipelines.rerun', () => {
  const posts = (s: FakeProviderServer) => s.requests.filter((r) => r.method === 'POST').map((r) => r.url);

  it('a finished run is re-run whole, whatever its conclusion', async () => {
    let server!: FakeProviderServer;
    const provider = await makeProvider((s) => {
      server = s;
      s.on('GET', '/repos/acme/app/actions/runs/9', { status: 200, body: { status: 'completed', conclusion: 'failure' } });
      s.on('POST', '/repos/acme/app/actions/runs/9/rerun', { status: 201, body: {} });
    });
    expect(await provider.pipelines.rerun!({ nativeId: '9', repositoryId: REPO_ID })).toBe('started');
    expect(posts(server)).toEqual(['/repos/acme/app/actions/runs/9/rerun']);
  });

  it('a run still going is left alone', async () => {
    let server!: FakeProviderServer;
    const provider = await makeProvider((s) => {
      server = s;
      s.on('GET', '/repos/acme/app/actions/runs/9', { status: 200, body: { status: 'in_progress', conclusion: null } });
    });
    expect(await provider.pipelines.rerun!({ nativeId: '9', repositoryId: REPO_ID })).toBe('running');
    expect(posts(server)).toEqual([]);
  });
});
