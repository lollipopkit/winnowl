import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderHostRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { CONTRACT_CONFIG_FILE_TEXT, FakeProviderServer, providerContractSuite } from '@reviewbot/testkit';
import { GithubProvider } from '../src/index.js';

const HOST_ID = '018f9a3c-0000-7000-8000-000000000001';
const REPO_ID = '018f9a3c-0000-7000-8000-000000000002';
const INST_ID = '018f9a3c-0000-7000-8000-000000000003';
const CR_ID = '018f9a3c-0000-7000-8000-000000000004';
const ISSUE_ID = '018f9a3c-0000-7000-8000-000000000005';

function host(baseUrl: string): ProviderHostRef {
  return { id: HOST_ID, provider: 'github', baseUrl, apiUrl: baseUrl, isSaas: true };
}

const pull = {
  id: 5001,
  number: 42,
  title: 'Add login',
  body: 'desc',
  state: 'open',
  draft: false,
  merged: false,
  mergeable: true,
  labels: [{ name: 'feature' }],
  user: { id: 7, login: 'alice', type: 'User' },
  head: { sha: 'aaaa', ref: 'feature/login', repo: { id: 900, private: false } },
  base: { sha: 'bbbb', ref: 'main', repo: { id: 900 } },
};

providerContractSuite({
  name: 'github',
  makeProvider: (baseUrl) =>
    new GithubProvider({
      client: new RestClient({ baseUrl }),
      host: host(baseUrl),
      resolveRepo: () => ({ owner: 'acme', repo: 'app' }),
    }),
  refs: {
    changeRequest: { id: CR_ID, repositoryId: REPO_ID, nativeId: '5001', number: 42, kind: 'pull-request' },
    repository: {
      id: REPO_ID,
      providerHostId: HOST_ID,
      installationId: INST_ID,
      nativeId: '900',
      namespace: 'acme',
      name: 'app',
      cloneUrl: 'https://github.com/acme/app.git',
      defaultBranch: 'main',
    },
    issue: { id: ISSUE_ID, repositoryId: REPO_ID, nativeId: '10', number: 7 },
    thread: {
      nativeId: '500',
      changeRequest: { id: CR_ID, repositoryId: REPO_ID, nativeId: '5001', number: 42, kind: 'pull-request' },
    },
    anchor: { path: 'src/a.ts', side: 'head', line: 10 },
  },
  configure: (server: FakeProviderServer) => {
    server
      .on('GET', '/repos/acme/app/pulls/42/files', {
        body: [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 }],
      })
      .on('GET', '/repos/acme/app/pulls/42', { body: pull })
      .on('GET', '/repos/acme/app/compare/', { body: { merge_base_commit: { sha: 'cccc' } } })
      // Idempotency lookup before creating: empty → POST.
      .on('GET', '/repos/acme/app/issues/42/comments', { body: [] })
      .on('GET', '/repos/acme/app/issues', { body: [] })
      .on('POST', '/repos/acme/app/issues/42/comments', { status: 201, body: { id: 111, html_url: 'u' } })
      .on('POST', '/repos/acme/app/pulls/42/comments/500/replies', {
        status: 201,
        body: { id: 222, html_url: 'u' },
      })
      .on('POST', '/repos/acme/app/pulls/42/comments', { status: 201, body: { id: 333, html_url: 'u' } })
      // No existing check run → POST.
      .on('GET', '/repos/acme/app/commits/', { body: { check_runs: [] } })
      .on('POST', '/repos/acme/app/check-runs', { status: 201, body: { id: 444, html_url: 'u' } })
      .on('POST', '/repos/acme/app/issues', { status: 201, body: { id: 555, number: 9, html_url: 'u' } })
      .on('POST', '/repos/acme/app/issues/42/reactions', { status: 201, body: { id: 777, content: 'eyes' } })
      .on('POST', '/repos/acme/app/issues/7/reactions', { status: 201, body: { id: 778, content: 'eyes' } })
      .on('PATCH', '/repos/acme/app/issues/comments/111', { status: 200, body: { id: 111 } })
      .on('GET', '/repos/acme/app/contents/.winnowl.yaml', {
        body: { content: Buffer.from(CONTRACT_CONFIG_FILE_TEXT, 'utf8').toString('base64'), encoding: 'base64' },
      });
  },
});

describe('github 接手回执:reactions + check-run upsert', () => {
  let server: FakeProviderServer;
  let baseUrl: string;
  let provider: GithubProvider;

  const repo = {
    id: REPO_ID,
    providerHostId: HOST_ID,
    installationId: INST_ID,
    nativeId: '900',
    namespace: 'acme',
    name: 'app',
    cloneUrl: 'https://github.com/acme/app.git',
    defaultBranch: 'main',
  };
  const cr = { id: CR_ID, repositoryId: REPO_ID, nativeId: '5001', number: 42, kind: 'pull-request' as const };

  beforeAll(async () => {
    server = new FakeProviderServer();
    server
      .on('POST', '/repos/acme/app/issues/42/reactions', { status: 201, body: { id: 777, content: 'eyes' } })
      .on('POST', '/repos/acme/app/issues/7/reactions', { status: 200, body: { id: 778, content: 'eyes' } })
      // Existing check run with the same name → PATCH.
      .on('GET', '/repos/acme/app/commits/', { body: { check_runs: [{ id: 999, name: 'winnowl/review' }] } })
      .on('PATCH', '/repos/acme/app/check-runs/999', { status: 200, body: { id: 999, html_url: 'u' } });
    baseUrl = await server.listen();
    provider = new GithubProvider({ client: new RestClient({ baseUrl }), host: host(baseUrl), resolveRepo: () => ({ owner: 'acme', repo: 'app' }) });
  });
  afterAll(async () => await server.close());

  it('addToChangeRequest → POST issues/{number}/reactions content=eyes', async () => {
    await provider.reactions!.addToChangeRequest(cr, 'eyes');
    const req = server.requests.find((r) => r.method === 'POST' && r.url.endsWith('/issues/42/reactions'));
    expect(req).toBeDefined();
    expect((JSON.parse(req!.body) as { content: string }).content).toBe('eyes');
  });

  it('addToIssue → POST issues/{number}/reactions', async () => {
    await provider.reactions!.addToIssue({ id: ISSUE_ID, repositoryId: REPO_ID, nativeId: '10', number: 7 }, 'eyes');
    expect(server.requests.some((r) => r.method === 'POST' && r.url.endsWith('/issues/7/reactions'))).toBe(true);
  });

  it('check-run 已存在 → upsert 走 PATCH 复用同一条(不新建)', async () => {
    const receipt = await provider.checks.createOrUpdate(
      repo,
      { name: 'winnowl/review', status: 'in-progress', title: 'Reviewing…', headSha: 'aaaa' },
      { key: 'check:x:aaaa' },
    );
    expect(receipt.nativeId).toBe('999');
    expect(server.requests.some((r) => r.method === 'PATCH' && r.url.endsWith('/check-runs/999'))).toBe(true);
    expect(server.requests.some((r) => r.method === 'POST' && r.url.endsWith('/check-runs'))).toBe(false);
  });
});

describe('github getFileContent(§37 gate 复核,免 clone 单文件)', () => {
  let server: FakeProviderServer;
  let provider: GithubProvider;

  beforeAll(async () => {
    server = new FakeProviderServer();
    server.on('GET', '/repos/acme/app/contents/.winnowl.yaml', {
      body: { content: Buffer.from('reviews:\n  auto:\n    enabled: true\n', 'utf8').toString('base64'), encoding: 'base64' },
    });
    const baseUrl = await server.listen();
    provider = new GithubProvider({ client: new RestClient({ baseUrl }), host: host(baseUrl), resolveRepo: () => ({ owner: 'acme', repo: 'app' }) });
  });
  afterAll(async () => await server.close());

  const repoRef = { id: REPO_ID, providerHostId: HOST_ID, installationId: INST_ID, nativeId: '900', namespace: 'acme', name: 'app', cloneUrl: 'x', defaultBranch: 'main' };

  it('存在 → base64 解码返回文本;带 ref query', async () => {
    const text = await provider.repositories.getFileContent!(repoRef, '.winnowl.yaml', 'head-sha');
    expect(text).toContain('enabled: true');
    const req = server.requests.find((r) => r.url.includes('/contents/.winnowl.yaml'));
    expect(req!.url).toContain('ref=head-sha');
  });

  it('404(无文件)→ null 不抛', async () => {
    const text = await provider.repositories.getFileContent!(repoRef, '.winnowl.yml');
    expect(text).toBeNull();
  });
});
