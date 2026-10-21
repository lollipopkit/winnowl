export interface RateLimitSnapshot {
  limit?: number;
  remaining?: number;
  /** epoch seconds */
  resetAt?: number;
}

function num(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** GitHub uses `x-ratelimit-*`, GitLab/Forgejo `ratelimit-*`. */
export function readRateLimit(headers: Headers): RateLimitSnapshot {
  const snapshot: RateLimitSnapshot = {};
  const limit = num(headers.get('x-ratelimit-limit') ?? headers.get('ratelimit-limit'));
  const remaining = num(headers.get('x-ratelimit-remaining') ?? headers.get('ratelimit-remaining'));
  const reset = num(headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset'));
  if (limit !== undefined) snapshot.limit = limit;
  if (remaining !== undefined) snapshot.remaining = remaining;
  if (reset !== undefined) snapshot.resetAt = reset;
  return snapshot;
}
