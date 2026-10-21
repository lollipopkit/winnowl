/** `/v1/auth/:provider/start` -> forge -> `/v1/auth/:provider/callback` -> session cookie -> 302 to console. */
import { createHash, randomBytes } from 'node:crypto';
import { apiBaseUrl, consoleBaseUrl } from '@reviewbot/config';
import { runWithoutTenant, type Db } from '@reviewbot/db';
import { mergeUsers } from '@reviewbot/entitlement';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { attachIdentity, resolveOrCreateUser, upgradePlaceholderEmail } from '../auth-db.js';
import { deleteLoginInstance, listLoginInstances, loadInstanceProviders, upsertLoginInstance } from '../auth/instances.js';
import { requirePlatformOperator } from '../platform-operator.js';
import type { MasterKeyProvider } from '@reviewbot/kms';
import { clearCookie, parseCookies, serializeCookie } from '../auth/cookies.js';
import { OAuthError, oidcLoginConfigured, type OAuthProvider } from '../auth/oauth.js';
import {
  AUTHED_HINT_COOKIE,
  SESSION_COOKIE,
  cookieSecure,
  sessionKey,
  sessionTtlSec,
  signSession,
  verifySession,
} from '../auth/session.js';

const STATE_COOKIE = 'winnowl_oauth_state';
const STATE_TTL_SEC = 600;
const STATE_ISSUER = 'winnowl-oauth-state';

/**
 * Only same-site absolute paths, to prevent open redirects. `//evil.com` and `/\evil.com` are
 * protocol-relative in browsers, so checking for a leading `/` is not enough.
 */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

/** Never derived from the Host header, which the attacker controls. */
function requiredConsoleBaseUrl(env: NodeJS.ProcessEnv): string {
  const base = consoleBaseUrl(env);
  if (!base) throw new Error('启用 OAuth 登录需要 CONSOLE_BASE_URL(redirect_uri 基址,不能从请求头推断)');
  return base;
}

/** Public API URL; the OAuth `redirect_uri` points here. */
function requiredApiBaseUrl(env: NodeJS.ProcessEnv): string {
  return apiBaseUrl(env) ?? requiredConsoleBaseUrl(env);
}

function redirectUriFor(env: NodeJS.ProcessEnv, providerId: string): string {
  return `${requiredApiBaseUrl(env)}/v1/auth/${providerId}/callback`;
}

/** The console opens its login dialog on `auth_error`; upstream error text goes to logs only, never the URL. */
function authErrorPath(code: string): string {
  return `/?auth_error=${encodeURIComponent(code)}`;
}

function failTo(reply: FastifyReply, base: string, code: string): FastifyReply {
  return reply.redirect(`${base}${authErrorPath(code)}`, 302);
}

interface StatePayload {
  st: string;
  next: string;
  link: boolean;
  /** PKCE code verifier; the cookie is httpOnly, so only this browser can finish the exchange. */
  cv: string;
  nonce: string;
}

async function signState(payload: StatePayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(STATE_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + STATE_TTL_SEC)
    .sign(sessionKey());
}

async function readState(token: string | undefined): Promise<StatePayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey(), { issuer: STATE_ISSUER });
    const st = typeof payload['st'] === 'string' ? payload['st'] : '';
    const cv = typeof payload['cv'] === 'string' ? payload['cv'] : '';
    const nonce = typeof payload['nonce'] === 'string' ? payload['nonce'] : '';
    if (!st || !cv || !nonce) return null;
    return { st, next: safeNext(payload['next']), link: payload['link'] === true, cv, nonce };
  } catch {
    return null;
  }
}

export interface AuthRoutesDeps {
  /** Built-in providers from env; self-hosted instances are loaded from the DB per request. */
  providers: Map<string, OAuthProvider>;
  /** Required for self-hosted login (decrypts client_secret). */
  masterKey?: MasterKeyProvider;
  env?: NodeJS.ProcessEnv;
}

export function registerAuthRoutes(app: FastifyInstance, db: Db, deps: AuthRoutesDeps): void {
  const env = deps.env ?? process.env;

  // With OIDC login configured, forges (instances too) only link identities.
  const instancesLinkOnly = oidcLoginConfigured(env);
  /** Self-hosted instances are read per login so changes apply without restart. */
  const resolveProvider = async (id: string): Promise<OAuthProvider | undefined> => {
    // `default`: whichever built-in source signs in, for clients that only need "log in again".
    if (id === 'default') return [...deps.providers.values()].find((p) => !p.linkOnly);
    const builtin = deps.providers.get(id);
    if (builtin) return builtin;
    if (!deps.masterKey) return undefined;
    const instance = (await loadInstanceProviders(db, deps.masterKey)).get(id);
    return instance && instancesLinkOnly ? { ...instance, linkOnly: true } : instance;
  };
  const secure = cookieSecure(env);
  const sessionCookieOpts = { httpOnly: true, secure, sameSite: 'Lax' as const, path: '/' };
  // The hint must be readable by the console host; with the console on another subdomain it is
  // scoped to the shared parent (SESSION_HINT_COOKIE_DOMAIN). It carries no credential.
  const hintDomain = env.SESSION_HINT_COOKIE_DOMAIN?.trim();
  const hintCookieOpts = {
    httpOnly: false,
    secure,
    sameSite: 'Lax' as const,
    path: '/',
    ...(hintDomain ? { domain: hintDomain } : {}),
  };

  /** `login: false` sources only link an identity to a signed-in account. */
  app.get('/v1/auth/providers', async () => {
    const items: { id: string; label: string; kind: 'builtin' | 'instance'; login: boolean }[] = [...deps.providers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      kind: 'builtin',
      login: !p.linkOnly,
    }));
    if (deps.masterKey) {
      for (const inst of await listLoginInstances(db)) {
        items.push({ id: new URL(inst.issuer).host, label: inst.label, kind: 'instance', login: !instancesLinkOnly });
      }
    }
    return { items };
  });

  // Forgejo instance registration is operator-only: the issuer is an identity key.
  app.get('/v1/auth/instances', { preHandler: requirePlatformOperator }, async () => ({ items: await listLoginInstances(db) }));

  app.post('/v1/auth/instances', { preHandler: requirePlatformOperator }, async (req, reply) => {
    if (!deps.masterKey) return reply.code(501).send({ error: 'kms_required' });
    const body = (req.body ?? {}) as { provider?: string; url?: string; label?: string; clientId?: string; clientSecret?: string };
    if (!body.url || !body.clientId || !body.clientSecret) {
      return reply.code(400).send({ error: 'url/clientId/clientSecret 必填' });
    }
    try {
      const created = await upsertLoginInstance(db, deps.masterKey, {
        provider: body.provider ?? 'forgejo',
        url: body.url,
        ...(body.label ? { label: body.label } : {}),
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        ...(req.auth?.identity ? { createdBy: `${req.auth.identity.provider}:${req.auth.identity.subject}` } : {}),
      });
      req.log.info({ issuer: created.issuer }, '登记自建 Forgejo 登录源');
      return created;
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_instance', reason: (err as Error).message });
    }
  });

  app.delete('/v1/auth/instances/:id', { preHandler: requirePlatformOperator }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await deleteLoginInstance(db, id))) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  /** `mode=link` attaches another identity to the current account: the session proves A, this OAuth proves B. */
  app.get('/v1/auth/:provider/start', async (req, reply) => {
    const { provider: providerId } = req.params as { provider: string };
    const provider = await resolveProvider(providerId);
    const base = requiredConsoleBaseUrl(env);
    if (!provider) return failTo(reply, base, 'unknown_provider');
    const q = req.query as { next?: string; mode?: string };
    const link = q.mode === 'link';
    if (provider.linkOnly && !link) return failTo(reply, base, 'login_disabled');
    try {
      await provider.prepare?.();
    } catch (err) {
      req.log.error({ err, provider: providerId }, 'OAuth 登录源不可用');
      return failTo(reply, base, 'provider_error');
    }
    const state = randomBytes(32).toString('base64url');
    const cv = randomBytes(32).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const payload: StatePayload = { st: state, next: safeNext(q.next), link, cv, nonce };
    reply.header('set-cookie', serializeCookie(STATE_COOKIE, await signState(payload), { ...sessionCookieOpts, maxAgeSec: STATE_TTL_SEC }));
    const codeChallenge = createHash('sha256').update(cv).digest('base64url');
    return reply.redirect(provider.authorizeUrl({ redirectUri: redirectUriFor(env, provider.id), state, codeChallenge, nonce }), 302);
  });

  app.get('/v1/auth/:provider/callback', async (req, reply) => {
    const { provider: providerId } = req.params as { provider: string };
    const base = requiredConsoleBaseUrl(env);
    const provider = await resolveProvider(providerId);
    const cookies = parseCookies(req.headers.cookie);
    // Single-use state cookie, cleared up front to prevent replay.
    const setCookies: string[] = [clearCookie(STATE_COOKIE, sessionCookieOpts)];
    const goto = (path: string): FastifyReply => {
      reply.header('set-cookie', setCookies);
      return reply.redirect(`${base}${path}`, 302);
    };
    const fail = (code: string): FastifyReply => goto(authErrorPath(code));
    if (!provider) return fail('unknown_provider');

    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) {
      req.log.warn({ provider: providerId, error: q.error }, 'OAuth 授权被拒');
      return fail('denied');
    }
    const saved = await readState(cookies[STATE_COOKIE]);
    if (!saved || !q.state || q.state !== saved.st) return fail('state_mismatch');
    if (!q.code) return fail('missing_code');

    let identity;
    try {
      const token = await provider.exchangeCode({ code: q.code, redirectUri: redirectUriFor(env, provider.id), codeVerifier: saved.cv });
      identity = await provider.fetchIdentity(token, { nonce: saved.nonce });
    } catch (err) {
      const code = err instanceof OAuthError ? err.code : 'provider_error';
      req.log.error({ err, provider: providerId }, 'OAuth 登录失败');
      return fail(code);
    }

    // Link mode requires a valid session; otherwise this is a plain login.
    const current = saved.link ? await verifySession(cookies[SESSION_COOKIE] ?? '') : null;
    if (saved.link && current) {
      try {
        const owner = await resolveOrCreateUser(db, identity);
        if (owner !== current.userId) {
          // The current user is the winner.
          // Deliberately cross-tenant: the merge moves the loser's rows in every tenant; under the
          // callback tenant's context the others would be invisible and cascade-deleted.
          const result = await runWithoutTenant(() => mergeUsers(db, current.userId, owner));
          req.log.info({ ...result }, '账号关联:已合并');
        } else {
          await attachIdentity(db, current.userId, identity);
        }
        await upgradePlaceholderEmail(db, current.userId, identity.email);
      } catch (err) {
        req.log.error({ err }, '账号关联失败');
        return fail('link_failed');
      }
      // The session is unchanged.
      return goto(saved.next);
    }

    // A link-only source never starts a session, also when the link session expired meanwhile.
    if (provider.linkOnly) return fail('login_disabled');
    const userId = await resolveOrCreateUser(db, identity);
    const ttlSec = sessionTtlSec(env);
    const session = await signSession(
      { userId, provider: identity.provider, issuer: identity.issuer, subject: identity.subject, ...(identity.login ? { login: identity.login } : {}) },
      { ttlSec },
    );
    setCookies.push(
      serializeCookie(SESSION_COOKIE, session, { ...sessionCookieOpts, maxAgeSec: ttlSec }),
      serializeCookie(AUTHED_HINT_COOKIE, '1', { ...hintCookieOpts, maxAgeSec: ttlSec }),
    );
    req.log.info({ provider: identity.provider, login: identity.login, userId }, '登录成功');
    return goto(saved.next);
  });

  app.post('/v1/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', [clearCookie(SESSION_COOKIE, sessionCookieOpts), clearCookie(AUTHED_HINT_COOKIE, hintCookieOpts)]);
    return { ok: true };
  });
}
