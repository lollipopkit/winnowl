export interface RateLimitState {
  count: number;
  /** epoch ms */
  windowStart: number;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  now: number;
}

export interface RateLimitResult {
  allowed: boolean;
  state: RateLimitState;
  remaining: number;
  resetAt: number;
}

/** Fixed window: resets when expired; allows and counts until the limit. */
export function checkRateLimit(state: RateLimitState | undefined, opts: RateLimitOptions): RateLimitResult {
  const current: RateLimitState =
    !state || opts.now - state.windowStart >= opts.windowMs
      ? { count: 0, windowStart: opts.now }
      : { ...state };

  const resetAt = current.windowStart + opts.windowMs;
  if (current.count >= opts.limit) {
    return { allowed: false, state: current, remaining: 0, resetAt };
  }
  const next: RateLimitState = { count: current.count + 1, windowStart: current.windowStart };
  return { allowed: true, state: next, remaining: Math.max(0, opts.limit - next.count), resetAt };
}
