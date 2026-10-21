import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { idempotencyMarker } from '@reviewbot/provider-contracts';
import { FakeProviderServer } from '@reviewbot/testkit';
import { GitlabProvider } from '../src/index.js';

/** Create endpoints are not idempotent; retries claim the previous result via a hidden marker. */
const KEY = 'action:018f0000-0000-7000-8000-0000000000f1:0';
const MARKER = idempotencyMarker(KEY);

const changeRequest = {
  id: '018f0000-0000-7000-8000-000000000004',
  repositoryId: '018f0000-0000-7000-8000-000000000002',
  nativeId: '5001',
  number: 7,
  kind: 'merge-request' as const,
};

const repo = {
  id: '018f0000-0000-7000-8000-000000000002',
  providerHostId: '018f0000-0000-7000-8000-000000000001',
  installationId: '018f0000-0000-7000-8000-000000000003',
  nativeId: '55',
  namespace: 'acme',
  name: 'app',
  cloneUrl: 'https://gitlab.com/acme/app.git',
  defaultBranch: 'main',
};

describe('GitLab provider 幂等标记(§8.1)', () => {
  let server: FakeProviderServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const make = async (): Promise<{ provider: GitlabProvider; server: FakeProviderServer }> => {
    const s = new FakeProviderServer();
    const url = await s.listen();
    server = s;
    const host: ProviderHostRef = {
      id: repo.providerHostId,
      provider: 'gitlab',
      baseUrl: url,
      apiUrl: url,
      isSaas: true,
    };
    return {
      server: s,
      provider: new GitlabProvider({
        client: new RestClient({ baseUrl: url }),
        host,
        resolveProject: () => ({ projectId: '55' }),
      }),
    };
  };

  it('MR 评论:已存在同一个幂等键的 note → 复用,不再发第二条', async () => {
    const { provider, server: s } = await make();
    s.on('GET', '/projects/55/merge_requests/7/notes', {
      status: 200,
      body: [
        { id: 1, body: 'unrelated' },
        { id: 900, body: `fixed it\n\n${MARKER}` },
      ],
    });
    s.on('POST', '/projects/55/merge_requests/7/notes', { status: 201, body: { id: 901 } });

    const receipt = await provider.discussions.createTopLevelComment(
      { kind: 'change-request', ref: changeRequest },
      { markdown: 'fixed it' },
      { key: KEY },
    );
    expect(receipt.nativeId).toBe('900');
    expect(s.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('MR 评论:没有匹配 → 新建,并且正文带上标记', async () => {
    const { provider, server: s } = await make();
    s.on('GET', '/projects/55/merge_requests/7/notes', { status: 200, body: [{ id: 1, body: 'x' }] });
    s.on('POST', '/projects/55/merge_requests/7/notes', { status: 201, body: { id: 901 } });

    const receipt = await provider.discussions.createTopLevelComment(
      { kind: 'change-request', ref: changeRequest },
      { markdown: 'fixed it' },
      { key: KEY },
    );
    expect(receipt.nativeId).toBe('901');
    const post = s.requests.find((r) => r.method === 'POST');
    expect(post?.json()).toMatchObject({ body: `fixed it\n\n${MARKER}` });
  });

  it('Issue:近窗口里已有同一个幂等键 → 复用;否则新建并带标记', async () => {
    const { provider, server: s } = await make();
    s.on('GET', '/projects/55/issues', {
      status: 200,
      body: [{ id: 401, iid: 5, web_url: 'https://gitlab.com/acme/app/-/issues/5', description: `t\n\n${MARKER}` }],
    });
    s.on('POST', '/projects/55/issues', {
      status: 201,
      body: { id: 402, iid: 6, web_url: 'https://gitlab.com/acme/app/-/issues/6' },
    });

    const hit = await provider.issues.create(
      repo,
      { title: 't', body: { markdown: 'tracked' } },
      { key: KEY },
    );
    expect(hit.ref.number).toBe(5);
    expect(s.requests.some((r) => r.method === 'POST')).toBe(false);
    expect(s.requests.find((r) => r.method === 'GET')?.url).toContain('updated_after=');
    expect(s.requests.find((r) => r.method === 'GET')?.url).toContain('state=all');
  });
});
