/** Session cache of `GET /v1/me`. UI trimming only hides entries that would 403; endpoints enforce permissions. */
import { writable, type Readable } from 'svelte/store';
import { activeTenant, holdRequestsUntil, recoverLostSession, storeActiveTenant } from './auth';
import { api, type Me } from './api';

export type { Me } from './api';

const ROLE_RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** Unknown roles rank as viewer. */
export function roleAtLeast(role: string | undefined, min: 'viewer' | 'member' | 'admin' | 'owner'): boolean {
  return (ROLE_RANK[role ?? 'viewer'] ?? 0) >= ROLE_RANK[min]!;
}

const store = writable<Me | null>(null);
let loading: Promise<Me> | null = null;

/** null until loaded; stays null on failure (most conservative trimming). */
export const me: Readable<Me | null> = { subscribe: store.subscribe };

/**
 * Active tenant to switch to, or null to keep the current one.
 * The backend requires an explicit tenant for multi-tenant users, so the frontend defaults to the first membership
 * (stable created_at order), also when the stored tenant is no longer a membership.
 */
export function defaultTenantFor(m: Me, current: string | null): string | null {
  const first = m.memberships[0];
  if (!first) return null;
  if (current && m.memberships.some((x) => x.tenantId === current)) return null;
  return first.tenantId;
}

/** Reachable without any membership: invites grant the first one, docs are public. */
const ONBOARDING_EXEMPT = ['/invites', '/docs'];

/**
 * With no membership every tenant endpoint returns 400/403, so block the whole app with onboarding instead of
 * rendering pages full of errors. Not while `me` is still loading, to avoid a flash on every reload.
 */
export function needsOnboarding(m: Me | null, pathname: string): boolean {
  if (!m || m.memberships.length > 0) return false;
  return !ONBOARDING_EXEMPT.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Idempotent. */
export function loadMe(): Promise<Me> {
  loading ??= (async () => {
    let m = await api.me();
    // Reaching here implies the hint cookie, so an anonymous identity means the session is lost.
    if (!m.userId) recoverLostSession();
    const desired = defaultTenantFor(m, activeTenant());
    if (desired) {
      storeActiveTenant(desired);
      // Refetch: the first response had no X-Tenant-Id, and storing it would briefly trim nav as a viewer.
      m = await api.me().catch(() => m);
    }
    store.set(m);
    return m;
  })();
  holdRequestsUntil(loading);
  return loading;
}
