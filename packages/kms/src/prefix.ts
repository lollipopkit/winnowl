export function tenantObjectPrefix(tenantId: string): string {
  return `${tenantId}/`;
}

export function tenantStorageKey(tenantId: string, kind: string, id: string): string {
  return `${tenantId}/${kind}/${id}`;
}

/** Must be called before every access to prevent cross-tenant reads. */
export function belongsToTenant(storageKey: string, tenantId: string): boolean {
  return storageKey.startsWith(`${tenantId}/`);
}
