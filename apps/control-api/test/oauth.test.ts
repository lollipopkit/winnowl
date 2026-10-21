import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubProvider, oauthProviders, OAuthError } from '../src/auth/oauth.js';

const ENV = { GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'secret' };

/** fetch stub keyed by URL prefix. */
function stubFetch(routes: Record<string, { ok?: boolean; status?: number; body: unknown }>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    const hit = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    if (!hit) throw new Error(`未桩接的 URL:${url}`);
    const { ok = true, status = 200, body } = hit[1];
    return { ok, status, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHub 登录源', () => {
  it('缺 client_id/secret → 不注册(登录页不该给一个按不动的按钮)', () => {
    expect(githubProvider({})).toBeUndefined();
    expect(githubProvider({ GITHUB_OAUTH_CLIENT_ID: 'cid' })).toBeUndefined();
    expect(oauthProviders({}).size).toBe(0);
    expect([...oauthProviders(ENV).keys()]).toEqual(['github']);
  });

  it('授权地址指向 github.com 且带 state / redirect_uri(host 写死,不随 env 漂移)', () => {
    const url = new URL(githubProvider(ENV)!.authorizeUrl({ redirectUri: 'https://console.test/v1/auth/github/callback', state: 'st' }));
    expect(url.origin).toBe('https://github.com');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('redirect_uri')).toBe('https://console.test/v1/auth/github/callback');
  });

  it('code 交换:成功取 access_token', async () => {
    stubFetch({ 'https://github.com/login/oauth/access_token': { body: { access_token: 'tok' } } });
    await expect(githubProvider(ENV)!.exchangeCode({ code: 'c', redirectUri: 'https://console.test/cb' })).resolves.toBe('tok');
  });

  it('**GitHub 用 200 + error 字段报失败**(code 失效/重放)→ 必须显式判,不能只看 HTTP 状态', async () => {
    stubFetch({ 'https://github.com/login/oauth/access_token': { body: { error: 'bad_verification_code', error_description: '过期' } } });
    await expect(githubProvider(ENV)!.exchangeCode({ code: 'c', redirectUri: 'https://console.test/cb' })).rejects.toBeInstanceOf(OAuthError);
  });

  it('身份解析:数字 id 为 subject(login 只作展示,可改名)', async () => {
    stubFetch({ 'https://api.github.com/user': { body: { id: 10864310, login: 'lollipopkit', email: 'me@example.com' } } });
    await expect(githubProvider(ENV)!.fetchIdentity('tok')).resolves.toEqual({
      provider: 'github',
      issuer: 'https://github.com',
      subject: '10864310',
      login: 'lollipopkit',
      email: 'me@example.com',
    });
  });

  it('邮箱私有 → 退查 /user/emails,**只收 primary+verified**(未验证邮箱不得进认人链路)', async () => {
    stubFetch({
      'https://api.github.com/user/emails': {
        body: [
          { email: 'unverified@example.com', primary: true, verified: false },
          { email: 'secondary@example.com', primary: false, verified: true },
        ],
      },
      'https://api.github.com/user': { body: { id: 1, login: 'x', email: null } },
    });
    // No primary+verified email -> none (an unverified email could hijack accounts).
    await expect(githubProvider(ENV)!.fetchIdentity('tok')).resolves.toEqual({ provider: 'github', issuer: 'https://github.com', subject: '1', login: 'x' });

    stubFetch({
      'https://api.github.com/user/emails': { body: [{ email: 'ok@example.com', primary: true, verified: true }] },
      'https://api.github.com/user': { body: { id: 1, login: 'x', email: null } },
    });
    await expect(githubProvider(ENV)!.fetchIdentity('tok')).resolves.toMatchObject({ email: 'ok@example.com' });
  });

  it('/user/emails 无权限(403)→ 不阻断登录,只是没有邮箱', async () => {
    stubFetch({
      'https://api.github.com/user/emails': { ok: false, status: 403, body: {} },
      'https://api.github.com/user': { body: { id: 2, login: 'y', email: null } },
    });
    await expect(githubProvider(ENV)!.fetchIdentity('tok')).resolves.toEqual({ provider: 'github', issuer: 'https://github.com', subject: '2', login: 'y' });
  });

  it('/user 失败 / 缺 id → OAuthError(不编造身份)', async () => {
    stubFetch({ 'https://api.github.com/user': { ok: false, status: 401, body: {} } });
    await expect(githubProvider(ENV)!.fetchIdentity('tok')).rejects.toBeInstanceOf(OAuthError);
    stubFetch({ 'https://api.github.com/user': { body: { login: 'no-id' } } });
    await expect(githubProvider(ENV)!.fetchIdentity('tok')).rejects.toBeInstanceOf(OAuthError);
  });
});
