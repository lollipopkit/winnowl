import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { idempotencyMarker } from '@reviewbot/provider-contracts';
import { FakeProviderServer } from '@reviewbot/testkit';
import { ForgejoProvider } from '../src/index.js';

/** Create endpoints are not idempotent; retries claim the previous result via a hidden marker. */
const KEY = 'action:018f0000-0000-7000-8000-0000000000f1:0';
const MARKER = idempotencyMarker(KEY);

const changeRequest = {
  id: '018f0000-0000-7000-8000-000000000004',
  repositoryId: '018f0000-0000-7000-8000-000000000002',
  nativeId: '5001',
  number: 7,
  kind: 'pull-request' as const,
};

const repo = {
  id: '018f0000-0000-7000-8000-000000000002',
  providerHostId: '018f0000-0000-7000-8000-000000000001',
  installationId: '018f0000-0000-7000-8000-000000000003',
  nativeId: '900',
  namespace: 'acme',
  name: 'app',
  cloneUrl: 'https://forgejo.example/acme/app.git',
  defaultBranch: 'main',
};

describe('Forgejo provider 幂等标记(§8.1)', () => {
  let server: FakeProviderServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const make = async (): Promise<{ provider: ForgejoProvider; server: FakeProviderServer }> => {
    const s = new FakeProviderServer();
    const url = await s.listen();
    server = s;
    const host: ProviderHostRef = {
      id: repo.providerHostId,
      provider: 'forgejo',
      baseUrl: url,
      apiUrl: url,
      isSaas: false,
    };
    return {
      server: s,
      provider: new ForgejoProvider({
        client: new RestClient({ baseUrl: url }),
        host,
        resolveRepo: () => ({ owner: 'acme', repo: 'app' }),
      }),
    };
  };

  it('顶层评论:已存在同一个幂等键 → 复用,不再发第二条', async () => {
    const { provider, server: s } = await make();
    s.on('GET', '/repos/acme/app/issues/7/comments', {
      status: 200,
      body: [
        { id: 1, html_url: 'x', body: 'unrelated' },
        { id: 900, html_url: 'https://forgejo.example/acme/app/issues/7#issuecomment-900', body: `fixed\n\n${MARKER}` },
      ],
    });
    s.on('POST', '/repos/acme/app/issues/7/comments', {
      status: 201,
      body: { id: 901, html_url: 'https://forgejo.example/acme/app/issues/7#issuecomment-901' },
    });

    const receipt = await provider.discussions.createTopLevelComment(
      { kind: 'change-request', ref: changeRequest },
      { markdown: 'fixed' },
      { key: KEY },
    );
    expect(receipt.nativeId).toBe('900');
    expect(s.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('顶层评论:没有匹配 → 新建,并且正文带上标记', async () => {
    const { provider, server: s } = await make();
    s.on('GET', '/repos/acme/app/issues/7/comments', { status: 200, body: [] });
    s.on('POST', '/repos/acme/app/issues/7/comments', { status: 201, body: { id: 901 } });

    const receipt = await provider.discussions.createTopLevelComment(
      { kind: 'change-request', ref: changeRequest },
      { markdown: 'fixed' },
      { key: KEY },
    );
    expect(receipt.nativeId).toBe('901');
    expect(s.requests.find((r) => r.method === 'POST')?.json()).toMatchObject({
      body: `fixed\n\n${MARKER}`,
    });
  });

  it('Issue:近窗口里已有同一个幂等键 → 复用,不再新建', async () => {
    const { provider, server: s } = await make();
    s.on('GET', '/repos/acme/app/issues', {
      status: 200,
      body: [{ id: 401, number: 5, html_url: 'https://forgejo.example/acme/app/issues/5', body: `t\n\n${MARKER}` }],
    });
    s.on('POST', '/repos/acme/app/issues', {
      status: 201,
      body: { id: 402, number: 6, html_url: 'https://forgejo.example/acme/app/issues/6' },
    });

    const hit = await provider.issues.create(
      repo,
      { title: 't', body: { markdown: 'tracked' } },
      { key: KEY },
    );
    expect(hit.ref.number).toBe(5);
    expect(s.requests.some((r) => r.method === 'POST')).toBe(false);
    expect(s.requests.find((r) => r.method === 'GET')?.url).toContain('since=');
  });
});
