import type { Role } from './roles.js';

export type ApiScope = 'repo:read' | 'repo:write' | 'review:trigger' | 'admin' | 'audit:read';

/** Scopes derive from the DB role (not a JWT claim); `admin` covers everything. */
export function scopesForRole(role: Role): ApiScope[] {
  switch (role) {
    case 'owner':
    case 'admin':
      return ['admin'];
    case 'member':
      return ['repo:read', 'review:trigger', 'audit:read'];
    case 'viewer':
      return ['repo:read', 'audit:read'];
  }
}

export function tokenHasScope(tokenScopes: readonly ApiScope[], required: ApiScope): boolean {
  if (tokenScopes.includes('admin')) return true;
  return tokenScopes.includes(required);
}

/** Provider tokens must never reach the frontend. */
export const PROVIDER_TOKEN_RETURNED_TO_FRONTEND = false;

const SECRET_KEY_RE = /(provider.?token|installation.?token|access.?token|secret|private.?key|password)/i;

/** Deep-walks the response and removes any sensitive key. */
export function redactForFrontend<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue;
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}
