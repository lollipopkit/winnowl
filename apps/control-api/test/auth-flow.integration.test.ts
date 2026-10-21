import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createSessionAuthResolver } from '../src/auth-db.js';
import { SESSION_COOKIE, verifySession } from '../src/auth/session.js';
import type { OAuthIdentity, OAuthProvider } from '../src/auth/oauth.js';

const CONSOLE = 'https://console.test';
const GH = 'https://github.com';

/** Fake forge: the code is the identity. */
function fauxProvider(identities: Record<string, OAuthIdentity>): OAuthProvider {
  return {
    id: 'github',
    authorizeUrl: ({ redirectUri, state }) => `${GH}/login/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    exchangeCode: async ({ code }) => code,
    fetchIdentity: async (token) => {
      const hit = identities[token];
      if (!hit) throw new Error('unknown code');
      return hit;
    },
  };
}

/** Set-Cookie headers -> name=value (attributes tested separately). */
function cookiesOf(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const out: Record<string, string> = {};
  for (const line of list) {
    const [pair] = String(line).split(';');
    const eq = pair!.indexOf('=');
    if (eq > 0) out[pair!.slice(0, eq)] = decodeURIComponent(pair!.slice(eq + 1));
  }
  return out;
}

function setCookieLines(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map(String);
}

describe('OAuth 登录流程(§39.3:forge → session cookie)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let app: FastifyInstance;
  const ALICE: OAuthIdentity = { provider: 'github', issuer: GH, subject: '1001', login: 'alice', email: 'alice@example.com' };
  const BOB: OAuthIdentity = { provider: 'github', issuer: GH, subject: '2002', login: 'bob' };
  const prevEnv: Record<string, string | undefined> = {};

  const login = async (code: string, opts: { mode?: string; next?: string; sessionCookie?: string } = {}) => {
    const start = await app.inject({
      method: 'GET',
      url: `/v1/auth/github/start?${new URLSearchParams({ ...(opts.next ? { next: opts.next } : {}), ...(opts.mode ? { mode: opts.mode } : {}) })}`,
    });
    const stateCookie = cookiesOf(start)['winnowl_oauth_state']!;
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cookie = [`winnowl_oauth_state=${encodeURIComponent(stateCookie)}`, ...(opts.sessionCookie ? [`${SESSION_COOKIE}=${encodeURIComponent(opts.sessionCookie)}`] : [])].join('; ');
    return app.inject({ method: 'GET', url: `/v1/auth/github/callback?code=${code}&state=${state}`, headers: { cookie } });
  };

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    for (const k of ['CONSOLE_BASE_URL', 'SESSION_SIGNING_KEY', 'SESSION_COOKIE_INSECURE']) prevEnv[k] = process.env[k];
    process.env.CONSOLE_BASE_URL = CONSOLE;
    process.env.SESSION_SIGNING_KEY = Buffer.alloc(32, 7).toString('base64');
    app = await buildServer({
      quiet: true,
      db,
      rbac: { resolveAuth: createSessionAuthResolver({ db }) },
      oauthProviders: new Map([['github', fauxProvider({ 'code-alice': ALICE, 'code-bob': BOB })]]),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await stop?.();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('start:带 state cookie 跳 forge;next 只接受站内路径(防开放重定向)', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/auth/github/start?next=https://evil.test/steal' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location as string).toContain(`${GH}/login/oauth/authorize`);
    const stateLine = setCookieLines(r).find((l) => l.startsWith('winnowl_oauth_state'))!;
    expect(stateLine).toContain('HttpOnly');
    expect(stateLine).toContain('SameSite=Lax');

    // External `next` is dropped.
    const done = await login('code-alice', { next: 'https://evil.test/steal' });
    expect(done.headers.location).toBe(`${CONSOLE}/`);
  });

  it('callback:签发 httpOnly session cookie + 非 httpOnly 的登录提示 cookie,并 JIT 开号', async () => {
    const r = await login('code-alice', { next: '/repos' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`${CONSOLE}/repos`);

    const lines = setCookieLines(r);
    const session = lines.find((l) => l.startsWith(SESSION_COOKIE))!;
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Lax');
    // The hint cookie is readable by scripts and holds no credential.
    const hint = lines.find((l) => l.startsWith('winnowl_authed'))!;
    expect(hint).not.toContain('HttpOnly');
    expect(hint.split(';')[0]).toBe('winnowl_authed=1');
    // State cookie cleared (single use).
    expect(lines.some((l) => l.startsWith('winnowl_oauth_state') && l.includes('Max-Age=0'))).toBe(true);

    const claims = await verifySession(cookiesOf(r)[SESSION_COOKIE]!);
    expect(claims).toMatchObject({ provider: 'github', issuer: GH, subject: '1001', login: 'alice' });
    const user = await db.selectFrom('users').select(['id', 'email']).where('id', '=', claims!.userId).executeTakeFirstOrThrow();
    expect(user.email).toBe('alice@example.com');
  });

  it('session cookie → 后续请求解析出身份(/v1/me);无 cookie → 匿名 viewer', async () => {
    const session = cookiesOf(await login('code-alice'))[SESSION_COOKIE]!;
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { userId: string | null }).userId).toBeTruthy();

    const anon = await app.inject({ method: 'GET', url: '/v1/me' });
    expect((anon.json() as { role: string; userId: string | null }).role).toBe('viewer');
    expect((anon.json() as { userId: string | null }).userId).toBeNull();
  });

  it('伪造/过期 session → 401(前端据此跳登录),不是静默降级为匿名', async () => {
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ4In0.bad';
    const r = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: `${SESSION_COOKIE}=${forged}` } });
    expect(r.statusCode).toBe(401);
  });

  it('state 不匹配 / 缺 code / 授权被拒 → 跳登录页带短错误码,不签发 session', async () => {
    const bad = await app.inject({ method: 'GET', url: '/v1/auth/github/callback?code=code-alice&state=forged', headers: { cookie: 'winnowl_oauth_state=nonsense' } });
    expect(bad.headers.location).toBe(`${CONSOLE}/?auth_error=state_mismatch`);
    expect(cookiesOf(bad)[SESSION_COOKIE]).toBeUndefined();

    const denied = await app.inject({ method: 'GET', url: '/v1/auth/github/callback?error=access_denied&state=x' });
    expect(denied.headers.location).toBe(`${CONSOLE}/?auth_error=denied`);
  });

  it('mode=link:当前 session 不变,新身份挂到同一个账号(两侧凭证都由服务端验过)', async () => {
    const session = cookiesOf(await login('code-alice'))[SESSION_COOKIE]!;
    const alice = (await verifySession(session))!;

    const linked = await login('code-bob', { mode: 'link', next: '/account', sessionCookie: session });
    expect(linked.headers.location).toBe(`${CONSOLE}/account`);
    expect(cookiesOf(linked)[SESSION_COOKIE]).toBeUndefined(); // session not switched to bob

    const rows = await db.selectFrom('user_identities').select(['subject']).where('user_id', '=', alice.userId).execute();
    expect(rows.map((r) => r.subject).sort()).toEqual(['1001', '2002']);
  });

  it('mode=link 但没有有效 session → 退化成普通登录(不能让"关联"变成静默换人)', async () => {
    const r = await login('code-bob', { mode: 'link' });
    const claims = await verifySession(cookiesOf(r)[SESSION_COOKIE]!);
    expect(claims?.subject).toBe('2002');
  });

  it('logout:清掉两个 cookie', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { origin: CONSOLE } });
    expect(r.statusCode).toBe(200);
    const lines = setCookieLines(r);
    expect(lines.filter((l) => l.includes('Max-Age=0')).length).toBe(2);
  });

  it('CSRF:带 session cookie 的写请求,Origin 不在白名单 → 403', async () => {
    const session = cookiesOf(await login('code-alice'))[SESSION_COOKIE]!;
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(session)}`;
    const evil = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, origin: 'https://evil.test' } });
    expect(evil.statusCode).toBe(403);
    expect((evil.json() as { error: string }).error).toBe('csrf_origin_rejected');
    // No Origin and no Sec-Fetch-Site -> rejected.
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } })).statusCode).toBe(403);
    // Safari omits Origin on same-origin POSTs but sends Sec-Fetch-Site.
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie, origin: CONSOLE } })).statusCode).toBe(200);
  });

  it('CSRF:不带 cookie 的跨站写请求也拒绝(跨站表单强制登出)', async () => {
    // SameSite=Lax drops the cookie on a cross-site form POST; logout must still refuse to clear cookies.
    const evil = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { origin: 'https://evil.test' } });
    expect(evil.statusCode).toBe(403);
    expect(evil.headers['set-cookie']).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    // Non-browser callers (no Origin, no Sec-Fetch-Site, no cookie) are unaffected.
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout' })).statusCode).toBe(200);
  });
});

describe('console and API on different hosts (console on Cloudflare Pages)', () => {
  const API = 'https://api.console.test';
  let stop: () => Promise<void>;
  let app: FastifyInstance;
  const keys = ['CONSOLE_BASE_URL', 'API_BASE_URL', 'SESSION_HINT_COOKIE_DOMAIN', 'SESSION_SIGNING_KEY'];
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    stop = pg.stop;
    for (const k of keys) prevEnv[k] = process.env[k];
    process.env.CONSOLE_BASE_URL = CONSOLE;
    process.env.API_BASE_URL = `${API}/`;
    process.env.SESSION_HINT_COOKIE_DOMAIN = 'console.test';
    process.env.SESSION_SIGNING_KEY = Buffer.alloc(32, 9).toString('base64');
    const db = createDb(pg.pool);
    app = await buildServer({
      quiet: true,
      db,
      rbac: { resolveAuth: createSessionAuthResolver({ db }) },
      oauthProviders: new Map([
        ['github', fauxProvider({ code: { provider: 'github', issuer: GH, subject: '3003', login: 'carol' } })],
      ]),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await stop?.();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('sends the OAuth callback to the API host and the user back to the console', async () => {
    const start = await app.inject({ method: 'GET', url: '/v1/auth/github/start?next=/repos' });
    const authorize = new URL(start.headers.location as string);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${API}/v1/auth/github/callback`);
    // The state cookie stays host-only on the API host.
    expect(setCookieLines(start).find((l) => l.startsWith('winnowl_oauth_state'))).not.toContain('Domain=');

    const cookie = `winnowl_oauth_state=${encodeURIComponent(cookiesOf(start)['winnowl_oauth_state']!)}`;
    const done = await app.inject({
      method: 'GET',
      url: `/v1/auth/github/callback?code=code&state=${authorize.searchParams.get('state')}`,
      headers: { cookie },
    });
    expect(done.headers.location).toBe(`${CONSOLE}/repos`);
    const lines = setCookieLines(done);
    expect(lines.find((l) => l.startsWith(SESSION_COOKIE))).not.toContain('Domain=');
    expect(lines.find((l) => l.startsWith('winnowl_authed'))).toContain('Domain=console.test');

    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { origin: CONSOLE } });
    expect(setCookieLines(out).find((l) => l.startsWith('winnowl_authed'))).toMatch(/Domain=console\.test.*|Max-Age=0/);
    expect(setCookieLines(out).find((l) => l.startsWith('winnowl_authed'))).toContain('Domain=console.test');
  });
});
