import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderHostRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { FakeProviderServer } from '@reviewbot/testkit';
import { GithubProvider } from '../src/index.js';

const HOST_ID = '018f9a3c-0000-7000-8000-000000000001';

function host(baseUrl: string): ProviderHostRef {
  return { id: HOST_ID, provider: 'github', baseUrl, apiUrl: baseUrl, isSaas: true };
}

const cleanups: (() => Promise<void>)[] = [];

async function providerWith(configure: (s: FakeProviderServer) => void): Promise<{ provider: GithubProvider; server: FakeProviderServer }> {
  const server = new FakeProviderServer();
  configure(server);
  const baseUrl = await server.listen();
  cleanups.push(() => server.close());
  return {
    provider: new GithubProvider({
      client: new RestClient({ baseUrl }),
      host: host(baseUrl),
      resolveRepo: () => ({ owner: 'acme', repo: 'app' }),
      appSlug: 'winnowl',
    }),
    server,
  };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe('github identity(bot 账号 + commit 身份)', () => {
  it('App 安装:按 slug 查 `<slug>[bot]` 账号(GET /user 在 App token 下是 403)', async () => {
    const { provider, server } = await providerWith((s) => {
      s.on('GET', '/users/winnowl%5Bbot%5D', { body: { id: 305734977, login: 'winnowl[bot]', type: 'Bot' } });
      s.on('GET', '/user', { status: 403, body: { message: 'Resource not accessible by integration' } });
    });
    const actor = await provider.identity.botActor();
    expect(actor).toEqual({ providerUserId: '305734977', login: 'winnowl[bot]', type: 'bot' });
    // /user was not called: it is 403 for App tokens.
    expect(server.requests.some((r) => r.url === '/user')).toBe(false);
  });

  it('commitIdentity → `<id>+<login>@users.noreply.github.com`(否则 GitHub 挂不到账号,头像空白)', async () => {
    const { provider } = await providerWith((s) => {
      s.on('GET', '/users/winnowl%5Bbot%5D', { body: { id: 305734977, login: 'winnowl[bot]', type: 'Bot' } });
    });
    expect(await provider.identity.commitIdentity()).toEqual({
      name: 'winnowl[bot]',
      email: '305734977+winnowl[bot]@users.noreply.github.com',
    });
  });

  it('身份只查一次(缓存):每次交付都打一次账号查询没必要', async () => {
    const { provider, server } = await providerWith((s) => {
      s.on('GET', '/users/winnowl%5Bbot%5D', { body: { id: 7, login: 'winnowl[bot]', type: 'Bot' } });
    });
    await provider.identity.commitIdentity();
    await provider.identity.commitIdentity();
    expect(server.requests.filter((r) => r.url.startsWith('/users/')).length).toBe(1);
  });

  it('slug 查不到(PAT 部署 / slug 配错)→ 退回 GET /user 的账号', async () => {
    const { provider } = await providerWith((s) => {
      s.on('GET', '/users/winnowl%5Bbot%5D', { status: 404, body: { message: 'Not Found' } });
      s.on('GET', '/user', { body: { id: 42, login: 'winnowl', type: 'User' } });
    });
    expect(await provider.identity.commitIdentity()).toEqual({
      name: 'winnowl',
      email: '42+winnowl@users.noreply.github.com',
    });
  });

  it('两条路都失败 → null(由调用方兜底,不阻断交付)', async () => {
    const { provider } = await providerWith(() => undefined);
    expect(await provider.identity.commitIdentity()).toBeNull();
  });
});
