import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { idempotencyMarker } from '@reviewbot/provider-contracts';
import { FakeProviderServer } from '@reviewbot/testkit';
import { GithubProvider } from '../src/index.js';

// Create APIs are not idempotent; retries reclaim the previous result via a hidden marker in the body.
const KEY = 'action:018f0000-0000-7000-8000-0000000000f1:0';
const MARKER = idempotencyMarker(KEY);

const changeRequest = {
  id: '018f0000-0000-7000-8000-000000000004',
  repositoryId: '018f0000-0000-7000-8000-000000000002',
  nativeId: '5001',
  number: 42,
  kind: 'pull-request' as const,
};

const repo = {
  id: '018f0000-0000-7000-8000-000000000002',
  providerHostId: '018f0000-0000-7000-8000-000000000001',
  installationId: '018f0000-0000-7000-8000-000000000003',
  nativeId: '900',
  namespace: 'acme',
  name: 'app',
  cloneUrl: 'https://github.com/acme/app.git',
  defaultBranch: 'main',
};

describe('GitHub provider 幂等标记(§8.1)', () => {
  let server: FakeProviderServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const make = async (): Promise<{ provider: GithubProvider; server: FakeProviderServer }> => {
    const s = new FakeProviderServer();
    const url = await s.listen();
    server = s;
    const host: ProviderHostRef = {
      id: repo.providerHostId,
      provider: 'github',
      baseUrl: url,
      apiUrl: url,
      isSaas: true,
    };
    return {
      server: s,
      provider: new GithubProvider({
        client: new RestClient({ baseUrl: url }),
        host,
        resolveRepo: () => ({ owner: 'acme', repo: 'app' }),
      }),
    };
  };

  it('顶层评论:已存在同一个幂等键的评论 → 复用,不再发第二条', async () => {
    const { provider, server: s } = await make();
    s.on('GET', '/repos/acme/app/issues/42/comments', {
      status: 200,
      body: [
        { id: 700, html_url: 'https://github.com/acme/app/pull/42#issuecomment-700', body: 'old' },
        {
          id: 900,
          html_url: 'https://github.com/acme/app/pull/42#issuecomment-900',
          body: `fixed it\n\n${MARKER}`,
        },
      ],
    });
    s.on('POST', '/repos/acme/app/issues/42/comments', {
      status: 201,
      body: { id: 901, html_url: 'https://github.com/acme/app/pull/42#issuecomment-901' },
    });

    const receipt = await provider.discussions.createTopLevelComment(
      { kind: 'change-request', ref: changeRequest },
      { markdown: 'fixed it' },
      { key: KEY },
    );
    expect(receipt.nativeId).toBe('900');
    expect(s.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('顶层评论:没有匹配 → 新建,并且正文带上标记(下一次重试才认得出来)', async () => {
    const { provider, server: s } = await make();
    s.on('GET', '/repos/acme/app/issues/42/comments', {
      status: 200,
      body: [{ id: 700, html_url: 'x', body: 'unrelated' }],
    });
    s.on('POST', '/repos/acme/app/issues/42/comments', {
      status: 201,
      body: { id: 901, html_url: 'https://github.com/acme/app/pull/42#issuecomment-901' },
    });

    const receipt = await provider.discussions.createTopLevelComment(
      { kind: 'change-request', ref: changeRequest },
      { markdown: 'fixed it' },
      { key: KEY },
    );
    expect(receipt.nativeId).toBe('901');
    const post = s.requests.find((r) => r.method === 'POST');
    expect(post?.json()).toMatchObject({ body: `fixed it\n\n${MARKER}` });
  });

  it('Issue:近窗口里已有同一个幂等键的 Issue → 复用,不再新建', async () => {
    const { provider, server: s } = await make();
    s.on('GET', '/repos/acme/app/issues', {
      status: 200,
      body: [
        { id: 400, number: 4, html_url: 'https://github.com/acme/app/issues/4', body: 'other' },
        {
          id: 401,
          number: 5,
          html_url: 'https://github.com/acme/app/issues/5',
          body: `tracked\n\n${MARKER}`,
        },
      ],
    });
    s.on('POST', '/repos/acme/app/issues', {
      status: 201,
      body: { id: 402, number: 6, html_url: 'https://github.com/acme/app/issues/6' },
    });

    const receipt = await provider.issues.create(repo, { title: 't', body: { markdown: 'tracked' } }, {
      key: KEY,
    });
    expect(receipt.ref.nativeId).toBe('401');
    expect(receipt.ref.number).toBe(5);
    expect(s.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('Issue:没有匹配 → 新建,并在近窗口内检索(而不是整个仓库历史)', async () => {
    const { provider, server: s } = await make();
    s.on('GET', '/repos/acme/app/issues', { status: 200, body: [] });
    s.on('POST', '/repos/acme/app/issues', {
      status: 201,
      body: { id: 402, number: 6, html_url: 'https://github.com/acme/app/issues/6' },
    });

    const receipt = await provider.issues.create(repo, { title: 't', body: { markdown: 'tracked' } }, {
      key: KEY,
    });
    expect(receipt.ref.number).toBe(6);
    const list = s.requests.find((r) => r.method === 'GET');
    expect(list?.url).toContain('since=');
    const post = s.requests.find((r) => r.method === 'POST');
    expect(post?.json()).toMatchObject({ body: `tracked\n\n${MARKER}` });
  });
});
