import type { BackoffPolicy, JobFailureClass } from './types.js';

/**
 * Backoff is per failureClass because gateway outages last minutes while sandbox glitches last seconds.
 * Equal jitter (`d/2 + rand*d/2`) desynchronizes jobs that failed together; full jitter could pick ~0 and
 * defeat waiting out the outage.
 */

/** Fallback for unlisted classes, which are all non-retryable. */
export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = { baseSeconds: 5, capSeconds: 60 };

/**
 * Sized by typical recovery time per class:
 * - retryable_model: gateway outages last minutes; 30s base gives ~3-4 min over 4 attempts.
 * - retryable_provider: forge 429/5xx usually recover within tens of seconds.
 * - retryable_runner: sandbox glitches usually clear immediately.
 * - environment_setup: clone/dependency failures, mostly brief network drops.
 */
export const BACKOFF_POLICIES: Partial<Record<JobFailureClass, BackoffPolicy>> = {
  retryable_model: { baseSeconds: 30, capSeconds: 300 },
  retryable_provider: { baseSeconds: 10, capSeconds: 120 },
  retryable_runner: { baseSeconds: 5, capSeconds: 60 },
  environment_setup: { baseSeconds: 15, capSeconds: 180 },
};

export function backoffPolicyFor(failureClass: JobFailureClass): BackoffPolicy {
  return BACKOFF_POLICIES[failureClass] ?? DEFAULT_BACKOFF_POLICY;
}

/** Seconds to wait after failed attempt `attempt` (1-based): within `[d/2, d]`, `d = min(cap, base * 2^(attempt-1))`. */
export function computeBackoffSeconds(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const window = Math.min(policy.capSeconds, policy.baseSeconds * 2 ** (n - 1));
  const half = window / 2;
  return half + random() * half;
}
