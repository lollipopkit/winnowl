import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** JSON with sorted keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function configDigest(config: unknown): string {
  return createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
}
