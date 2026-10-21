/** The code exchange happens server-side: GitHub supports neither public-client PKCE nor id_tokens, so client_secret stays here. */
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface OAuthIdentity {
  provider: string;
  /** `oidc` for the login IdP's subject; forge identities (the default) map commenters to users. */
  kind?: 'oidc' | 'provider';
  /** Forge origin; identity key. */
  issuer: string;
  /** Stable forge user id; login can be renamed. */
  subject: string;
  login?: string;
  /** Only set when the forge reports it verified. */
  email?: string;
}

export interface OAuthProvider {
  id: string;
  /** Brand name for SaaS, the host for self-hosted instances. */
  label: string;
  /** Only links an identity to an account already signed in; never starts a session. */
  linkOnly?: boolean;
  /** Async setup before `authorizeUrl` (OIDC discovery). */
  prepare?: () => Promise<void>;
  /** `codeChallenge` (S256) and `nonce` are used by providers that support them. */
  authorizeUrl(params: { redirectUri: string; state: string; codeChallenge?: string; nonce?: string }): string;
  /** Resolves to the credential `fetchIdentity` reads: an access token, or an OIDC id_token. */
  exchangeCode(params: { code: string; redirectUri: string; codeVerifier?: string }): Promise<string>;
  fetchIdentity(credential: string, check?: { nonce?: string }): Promise<OAuthIdentity>;
}

/** Expected OAuth failures; routes map `code` to a short user-facing error without leaking upstream text. */
export class OAuthError extends Error {
  constructor(readonly code: 'exchange_failed' | 'identity_failed' | 'provider_error', message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

const HTTP_TIMEOUT_MS = 10_000;

async function postForm(url: string, body: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new OAuthError('exchange_failed', `token 端点 ${res.status}`);
  return res.json();
}

async function getJson(url: string, accessToken: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      // GitHub returns 403 without a User-Agent.
      'user-agent': 'winnowl-control-api',
      ...headers,
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new OAuthError('identity_failed', `用户端点 ${res.status}`);
  return res.json();
}

/**
 * Uses the GitHub App's client_id/secret (user-to-server flow). The host is hard-coded so misconfiguration
 * cannot send users' credentials to an unvetted site.
 * TODO(GHES): build URLs from `GITHUB_ENTERPRISE_BASE_URL` once it is validated against an allowlist.
 */
export function githubProvider(env: NodeJS.ProcessEnv = process.env): OAuthProvider | undefined {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  return {
    id: 'github',
    label: 'GitHub',
    authorizeUrl: ({ redirectUri, state }) => {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        // Ignored for GitHub Apps; needed when the credentials belong to an OAuth App.
        scope: 'read:user user:email',
      });
      return `https://github.com/login/oauth/authorize?${params.toString()}`;
    },
    exchangeCode: async ({ code, redirectUri }) => {
      const data = (await postForm('https://github.com/login/oauth/access_token', {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      })) as { access_token?: string; error?: string; error_description?: string };
      if (!data.access_token) {
        // GitHub answers an invalid or replayed code with 200 + an error field.
        throw new OAuthError('exchange_failed', data.error_description ?? data.error ?? '未返回 access_token');
      }
      return data.access_token;
    },
    fetchIdentity: async (accessToken) => {
      const gh = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
      const user = (await getJson('https://api.github.com/user', accessToken, gh)) as {
        id?: number | string;
        login?: string;
        email?: string | null;
      };
      if (user.id === undefined || user.id === null) throw new OAuthError('identity_failed', '用户信息缺 id');
      const identity: OAuthIdentity = {
        provider: 'github',
        issuer: 'https://github.com',
        subject: String(user.id),
        ...(user.login ? { login: user.login } : {}),
      };
      // /user omits private emails; fetch the primary from /user/emails, verified only (unverified emails could hijack accounts).
      const email = user.email ?? (await primaryVerifiedEmail(accessToken, gh));
      return email ? { ...identity, email } : identity;
    },
  };
}

async function primaryVerifiedEmail(accessToken: string, headers: Record<string, string>): Promise<string | undefined> {
  try {
    const list = (await getJson('https://api.github.com/user/emails', accessToken, headers)) as {
      email?: string;
      primary?: boolean;
      verified?: boolean;
    }[];
    const hit = Array.isArray(list) ? list.find((e) => e.primary && e.verified && e.email) : undefined;
    return hit?.email;
  } catch {
    // Without email permission (403) login continues with a placeholder address.
    return undefined;
  }
}

/**
 * Self-hosted Forgejo/Gitea. The instance comes from operator-registered login_instances with a normalized issuer.
 * Gitea does not report email verification, so these emails are never used for account merging.
 */
export function forgejoProvider(instance: { issuer: string; label: string; clientId: string; clientSecret: string }): OAuthProvider {
  const base = instance.issuer.replace(/\/+$/, '');
  return {
    id: new URL(base).host,
    label: instance.label,
    authorizeUrl: ({ redirectUri, state }) => {
      const params = new URLSearchParams({
        client_id: instance.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
      });
      return `${base}/login/oauth/authorize?${params.toString()}`;
    },
    exchangeCode: async ({ code, redirectUri }) => {
      const data = (await postForm(`${base}/login/oauth/access_token`, {
        client_id: instance.clientId,
        client_secret: instance.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      })) as { access_token?: string; error?: string; error_description?: string };
      if (!data.access_token) {
        throw new OAuthError('exchange_failed', data.error_description ?? data.error ?? '未返回 access_token');
      }
      return data.access_token;
    },
    fetchIdentity: async (accessToken) => {
      const user = (await getJson(`${base}/api/v1/user`, accessToken)) as {
        id?: number | string;
        login?: string;
        email?: string | null;
      };
      if (user.id === undefined || user.id === null) throw new OAuthError('identity_failed', '用户信息缺 id');
      return {
        provider: 'forgejo',
        issuer: base,
        subject: String(user.id),
        ...(user.login ? { login: user.login } : {}),
        ...(user.email ? { email: user.email } : {}),
      };
    },
  };
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/**
 * Generic OIDC (authorization code + PKCE, confidential client). Discovery is fetched once and its issuer
 * must equal the configured one, so a tampered document cannot redirect verification elsewhere.
 */
export function oidcProvider(env: NodeJS.ProcessEnv = process.env): OAuthProvider | undefined {
  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) return undefined;
  let discovery: Promise<OidcDiscovery & { jwks: ReturnType<typeof createRemoteJWKSet> }> | undefined;
  const discover = () => {
    discovery ??= (async () => {
      const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) throw new OAuthError('provider_error', `discovery ${res.status}`);
      const doc = (await res.json()) as OidcDiscovery;
      if (doc.issuer !== issuer) throw new OAuthError('provider_error', `discovery issuer ${doc.issuer} != ${issuer}`);
      return { ...doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
    })().catch((err: unknown) => {
      discovery = undefined; // retry on the next login rather than caching a failure
      throw err;
    });
    return discovery;
  };
  // The authorize URL is built synchronously, so the endpoint is known once discovery has run (see `prepare`).
  let authorizationEndpoint: string | undefined;
  return {
    id: 'oidc',
    label: env.OIDC_LABEL?.trim() || new URL(issuer).host,
    prepare: async () => {
      authorizationEndpoint = (await discover()).authorization_endpoint;
    },
    authorizeUrl: ({ redirectUri, state, codeChallenge, nonce }) => {
      if (!authorizationEndpoint) throw new OAuthError('provider_error', 'discovery not loaded');
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        state,
        ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: 'S256' } : {}),
        ...(nonce ? { nonce } : {}),
      });
      return `${authorizationEndpoint}?${params.toString()}`;
    },
    exchangeCode: async ({ code, redirectUri, codeVerifier }) => {
      const { token_endpoint } = await discover();
      const data = (await postForm(token_endpoint, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      })) as { id_token?: string; error?: string; error_description?: string };
      if (!data.id_token) throw new OAuthError('exchange_failed', data.error_description ?? data.error ?? 'no id_token');
      return data.id_token;
    },
    fetchIdentity: async (idToken, check) => {
      const { jwks } = await discover();
      let claims;
      try {
        ({ payload: claims } = await jwtVerify(idToken, jwks, { issuer, audience: clientId }));
      } catch (err) {
        throw new OAuthError('identity_failed', `id_token: ${(err as Error).message}`);
      }
      // The nonce binds the id_token to this browser's login attempt (replay of another session's token).
      if (!check?.nonce || claims['nonce'] !== check.nonce) throw new OAuthError('identity_failed', 'id_token nonce mismatch');
      if (typeof claims.sub !== 'string' || !claims.sub) throw new OAuthError('identity_failed', 'id_token has no sub');
      const login = claims['preferred_username'];
      const email = claims['email'];
      return {
        provider: 'oidc',
        kind: 'oidc',
        issuer,
        subject: claims.sub,
        ...(typeof login === 'string' && login ? { login } : {}),
        // Unverified addresses could take over another account through email merging.
        ...(typeof email === 'string' && claims['email_verified'] === true ? { email } : {}),
      };
    },
  };
}

/**
 * Built-in providers configured via env; self-hosted ones come from auth/instances.ts. With OIDC configured it
 * is the only way to sign in: forges then only link their identity (comments map to platform users through it).
 */
export function oauthProviders(env: NodeJS.ProcessEnv = process.env): Map<string, OAuthProvider> {
  const out = new Map<string, OAuthProvider>();
  const oidc = oidcProvider(env);
  if (oidc) out.set(oidc.id, oidc);
  const github = githubProvider(env);
  if (github) out.set(github.id, oidc ? { ...github, linkOnly: true } : github);
  return out;
}

/** OIDC login is configured, so forge logins only link identities. */
export function oidcLoginConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return oidcProvider(env) !== undefined;
}
