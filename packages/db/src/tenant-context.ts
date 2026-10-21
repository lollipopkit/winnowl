import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Tenant context for RLS. Entry points (per job / per request) set it; the driver in client.ts applies it
 * on every connection checkout, so long-running jobs need no wrapping transaction.
 *
 * Wrap the rest of the request/job in `runWithTenant` rather than using `enterWith`: `enterWith` only
 * changes the current async frame, so continuations after an await would still see no tenant.
 *
 * `runWithoutTenant` is the explicit cross-tenant escape hatch; every call site must justify it in a comment.
 */

interface TenantStore {
  tenantId: string | null;
}

const storage = new AsyncLocalStorage<TenantStore>();

/** `tenantId` null = no tenant (anonymous or deliberate cross-tenant); the driver maps it to '' (RLS unset = permissive). */
export function runWithTenant<T>(tenantId: string | null, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

/** Leaves tenant isolation; only for deliberate cross-tenant queries, justified at the call site. */
export function runWithoutTenant<T>(fn: () => T): T {
  return runWithTenant(null, fn);
}

export function currentTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}
