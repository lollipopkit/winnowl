/**
 * Console auth: login redirects to `/v1/auth/<provider>/start`; the backend does the OAuth exchange and sets an
 * httpOnly session cookie. The SPA never handles credentials, so XSS cannot steal the session.
 */
const TENANT_KEY = 'winnowl_tenant';
/** Non-httpOnly hint cookie set by the backend: "probably logged in", carries no credential. */
const AUTHED_HINT_COOKIE = 'winnowl_authed';

function ls(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage; // SSR / no DOM
}

const ME_PATH = '/v1/me';

/**
 * API origin. Empty = same origin (dev proxy, compose/k3s single-origin deployments); the
 * Cloudflare Pages build sets `VITE_API_BASE` to the API host. The session cookie lives on that
 * host, so every call sends credentials explicitly (`include`).
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
const apiUrl = (path: string): string => `${API_BASE}${path}`;

/**
 * Other requests wait until the active tenant is settled: a stale stored tenant would make first-screen requests
 * fail, and fixing it in `loadMe` would not refetch them. Only requests wait; rendering does not.
 */
let tenantSettled: Promise<void> = Promise.resolve();

export function holdRequestsUntil(settled: Promise<unknown>): void {
  tenantSettled = settled.then(
    () => undefined,
    () => undefined,
  );
}

export function activeTenant(): string | null {
  return ls()?.getItem(TENANT_KEY) ?? null;
}

/** Stores the active tenant without reloading; `authFetch` reads it per request. */
export function storeActiveTenant(tenantId: string | null): void {
  const store = ls();
  if (!store) return;
  if (tenantId) store.setItem(TENANT_KEY, tenantId);
  else store.removeItem(TENANT_KEY);
}

/** Switches tenant with a full reload, discarding all in-memory SPA state. */
export function setActiveTenant(tenantId: string | null): void {
  storeActiveTenant(tenantId);
  // `/` is the landing page, which would bounce a logged-in user to the dashboard anyway.
  location.assign('/dashboard');
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

/**
 * Only decides whether to render the login page or the app shell; not an authorization check.
 * The real session is the httpOnly cookie, and the backend enforces auth (401 -> login).
 */
export function isAuthed(): boolean {
  return readCookie(AUTHED_HINT_COOKIE) === '1';
}

/** Built-in providers (e.g. `github`) come from deployment config; self-hosted instances use their host. */
export type AuthProviderId = string;

export interface AuthProvider {
  id: AuthProviderId;
  /** Brand name, or the instance's domain. */
  label: string;
  kind: 'builtin' | 'instance';
  /** false: only links an identity to the signed-in account (forges when OIDC login is configured). */
  login: boolean;
}

/**
 * `next` must be a same-site path (validated again by the backend) to prevent open redirects.
 * `linkMode` links a second identity to the current account; the backend verifies both the session and the new OAuth.
 */
export function startLogin(opts: { provider?: AuthProviderId; linkMode?: boolean; next?: string } = {}): void {
  const params = new URLSearchParams();
  const next = opts.next ?? (opts.linkMode ? '/account' : location.pathname + location.search);
  if (next.startsWith('/') && !next.startsWith('//')) params.set('next', next);
  if (opts.linkMode) params.set('mode', 'link');
  // Linking adds a forge identity; a plain login goes to whichever source signs in.
  location.href = apiUrl(`/v1/auth/${opts.provider ?? (opts.linkMode ? 'github' : 'default')}/start?${params.toString()}`);
}

/** Empty when the backend has none configured. */
export async function authProviders(): Promise<AuthProvider[]> {
  const res = await fetch(apiUrl('/v1/auth/providers'), { credentials: 'include' });
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: AuthProvider[] };
  return data.items ?? [];
}

/** Logout needs the Origin header (CSRF gate); then reloads to the logged-out state. */
export async function logout(): Promise<void> {
  await fetch(apiUrl('/v1/auth/logout'), { method: 'POST', credentials: 'include' }).catch(() => undefined);
  location.assign('/');
}

const RELOGIN_AT = 'winnowl_relogin_at';

/**
 * The hint cookie says logged in but the API sees an anonymous request: the session cookie expired or belongs to
 * another host. Clear the stale hint and log in again; if still anonymous within a minute, the browser is not
 * sending the cookie to the API (e.g. blocked cross-subdomain cookies), so stop and report instead of looping.
 */
export function recoverLostSession(): never {
  try {
    document.cookie = `${AUTHED_HINT_COOKIE}=; Max-Age=0; Path=/`;
  } catch {
    /* cookie not writable: continue */
  }
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOGIN_AT)) || 0;
  } catch {
    /* private mode: treat as not yet retried */
  }
  if (Date.now() - last < 60_000) {
    location.assign('/?auth_error=session_not_established');
    throw new Error('session_not_established');
  }
  try {
    sessionStorage.setItem(RELOGIN_AT, String(Date.now()));
  } catch {
    /* cannot store: no loop guard; worst case one extra redirect */
  }
  startLogin();
  throw new Error('session_lost');
}

/** Throws to abort the current request chain. */
function redirectToLogin(): never {
  startLogin();
  throw new Error('session_expired');
}

/**
 * Sends the session cookie (`include`, also cross-origin), adds the active tenant header, and turns 401 into a login redirect.
 * 400 no_tenant is not a lost session and is left to the page.
 */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  // `/v1/me` determines the active tenant, so it must not wait on itself.
  if (path !== ME_PATH) await tenantSettled;
  const tenant = activeTenant();
  const res = await fetch(apiUrl(path), {
    ...init,
    credentials: 'include',
    headers: { ...(init.headers ?? {}), ...(tenant ? { 'X-Tenant-Id': tenant } : {}) },
  });
  if (res.status === 401) redirectToLogin();
  return res;
}
