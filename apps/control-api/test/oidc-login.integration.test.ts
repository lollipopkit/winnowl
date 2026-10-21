import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createDb, type Db } from '@reviewbot/db';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createSessionAuthResolver } from '../src/auth-db.js';
import { SESSION_COOKIE, verifySession } from '../src/auth/session.js';
import { oauthProviders, type OAuthIdentity, type OAuthProvider } from '../src/auth/oauth.js';

const CONSOLE = 'https://console.test';
const CLIENT_ID = 'winnowl';

interface Grant {
  sub: string;
  email?: string;
  verified?: boolean;
  /** Overrides the nonce the authorize request carried. */
  nonce?: string;
}

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

describe('OIDC login (the only way to sign in once configured)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let app: FastifyInstance;
  let idp: Server;
  let issuer = '';
  /** code → what the IdP will put in the id_token, plus the PKCE challenge/nonce of its authorize request. */
  const codes = new Map<string, Grant & { challenge: string; requestNonce: string }>();
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // EdDSA (Ed25519), as the live IdP signs id_tokens.
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' };
    idp = createServer((req, res) => {
      const url = new URL(req.url ?? '/', issuer);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname.endsWith('/.well-known/openid-configuration')) {
        return json(200, { issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`, jwks_uri: `${issuer}jwks` });
      }
      if (url.pathname.endsWith('/jwks')) return json(200, { keys: [jwk] });
      if (url.pathname.endsWith('/token') && req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          void (async () => {
            const form = new URLSearchParams(body);
            const grant = codes.get(form.get('code') ?? '');
            const verifier = form.get('code_verifier') ?? '';
            if (!grant || createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) {
              return json(400, { error: 'invalid_grant' });
            }
            const idToken = await new SignJWT({
              nonce: grant.nonce ?? grant.requestNonce,
              preferred_username: grant.sub,
              ...(grant.email ? { email: grant.email, email_verified: grant.verified === true } : {}),
            })
              .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
              .setIssuer(issuer)
              .setAudience(CLIENT_ID)
              .setSubject(grant.sub)
              .setIssuedAt()
              .setExpirationTime('5m')
              .sign(privateKey);
            json(200, { access_token: 'at', token_type: 'Bearer', id_token: idToken });
          })();
        });
        return;
      }
      json(404, {});
    });
    await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
    issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/auth/v1/`;

    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    for (const k of ['CONSOLE_BASE_URL', 'SESSION_SIGNING_KEY', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']) prevEnv[k] = process.env[k];
    Object.assign(process.env, {
      CONSOLE_BASE_URL: CONSOLE,
      SESSION_SIGNING_KEY: Buffer.alloc(32, 9).toString('base64'),
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: 's3cret',
    });
    const providers = oauthProviders({ ...process.env, GITHUB_OAUTH_CLIENT_ID: 'gh', GITHUB_OAUTH_CLIENT_SECRET: 'gh' });
    // Swap the real GitHub source for a fake one, keeping its link-only flag.
    const ALICE_GH: OAuthIdentity = { provider: 'github', issuer: 'https://github.com', subject: '1001', login: 'alice', email: 'alice@example.com' };
    const fakeGithub: OAuthProvider = {
      ...providers.get('github')!,
      authorizeUrl: ({ state }) => `https://github.com/login/oauth/authorize?state=${state}`,
      exchangeCode: async ({ code }) => code,
      fetchIdentity: async () => ALICE_GH,
    };
    providers.set('github', fakeGithub);
    app = await buildServer({ quiet: true, db, rbac: { resolveAuth: createSessionAuthResolver({ db }) }, oauthProviders: providers });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await stop?.();
    await new Promise((r) => idp?.close(r));
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Starts at `/v1/auth/<source>/start`, lets the IdP issue `grant`, and returns the callback response. */
  async function oidcLogin(grant: Grant, opts: { source?: string; mode?: string; session?: string } = {}) {
    const start = await app.inject({
      method: 'GET',
      url: `/v1/auth/${opts.source ?? 'default'}/start${opts.mode ? `?mode=${opts.mode}` : ''}`,
      ...(opts.session ? { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(opts.session)}` } } : {}),
    });
    const authorize = new URL(start.headers.location as string);
    expect(authorize.origin + authorize.pathname).toBe(`${issuer}authorize`);
    const code = `code-${codes.size}`;
    codes.set(code, { ...grant, challenge: authorize.searchParams.get('code_challenge')!, requestNonce: authorize.searchParams.get('nonce')! });
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authorize.searchParams.get('state')!;
    return app.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=${code}&state=${state}`,
      headers: {
        cookie: [`winnowl_oauth_state=${encodeURIComponent(cookiesOf(start)['winnowl_oauth_state']!)}`, ...(opts.session ? [`${SESSION_COOKIE}=${encodeURIComponent(opts.session)}`] : [])].join('; '),
      },
    });
  }

  it('lists OIDC as the sign-in source and forges as link-only; a forge cannot start a session', async () => {
    const list = (await app.inject({ method: 'GET', url: '/v1/auth/providers' })).json() as { items: { id: string; login: boolean }[] };
    expect(list.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'oidc', login: true }), expect.objectContaining({ id: 'github', login: false })]));
    const r = await app.inject({ method: 'GET', url: '/v1/auth/github/start' });
    expect(r.headers.location).toBe(`${CONSOLE}/?auth_error=login_disabled`);
  });

  it('signs in with a verified id_token bound to this login attempt (PKCE + nonce)', async () => {
    const r = await oidcLogin({ sub: 'u-alice', email: 'alice@example.com', verified: true });
    expect(r.headers.location).toBe(`${CONSOLE}/`);
    const claims = await verifySession(cookiesOf(r)[SESSION_COOKIE]!);
    expect(claims).toMatchObject({ provider: 'oidc', issuer, subject: 'u-alice' });
    const identity = await db.selectFrom('user_identities').selectAll().where('subject', '=', 'u-alice').executeTakeFirstOrThrow();
    expect(identity).toMatchObject({ kind: 'oidc', issuer, user_id: claims!.userId });
    // Linking GitHub afterwards attaches the forge identity to the same account.
    const linked = await app.inject({ method: 'GET', url: '/v1/auth/github/start?mode=link', headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookiesOf(r)[SESSION_COOKIE]!)}` } });
    const state = new URL(linked.headers.location as string).searchParams.get('state')!;
    await app.inject({
      method: 'GET',
      url: `/v1/auth/github/callback?code=x&state=${state}`,
      headers: { cookie: `winnowl_oauth_state=${encodeURIComponent(cookiesOf(linked)['winnowl_oauth_state']!)}; ${SESSION_COOKIE}=${encodeURIComponent(cookiesOf(r)[SESSION_COOKIE]!)}` },
    });
    const gh = await db.selectFrom('user_identities').select('user_id').where('issuer', '=', 'https://github.com').where('subject', '=', '1001').executeTakeFirstOrThrow();
    expect(gh.user_id).toBe(claims!.userId);
  });

  it('merges by email only when the IdP verified it', async () => {
    const alice = await db.selectFrom('user_identities').select('user_id').where('subject', '=', 'u-alice').executeTakeFirstOrThrow();
    const again = await oidcLogin({ sub: 'u-alice-2', email: 'alice@example.com', verified: true });
    expect((await verifySession(cookiesOf(again)[SESSION_COOKIE]!))!.userId).toBe(alice.user_id);
    const unverified = await oidcLogin({ sub: 'u-mallory', email: 'alice@example.com', verified: false });
    expect((await verifySession(cookiesOf(unverified)[SESSION_COOKIE]!))!.userId).not.toBe(alice.user_id);
  });

  it('rejects an id_token issued for another login attempt', async () => {
    const r = await oidcLogin({ sub: 'u-eve', nonce: 'someone-elses-nonce' });
    expect(r.headers.location).toBe(`${CONSOLE}/?auth_error=identity_failed`);
    expect(cookiesOf(r)[SESSION_COOKIE]).toBeUndefined();
  });
});
