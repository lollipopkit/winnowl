/** Optional expiry in a request body: ISO date in the future; anything else → 'invalid'. */
export function parseExpiry(v: unknown): Date | undefined | 'invalid' {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) || d.getTime() <= Date.now() ? 'invalid' : d;
}
