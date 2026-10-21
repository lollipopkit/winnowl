import type { RetentionClass, RetentionPolicy, RetentionRule } from './types.js';

const DAY_MS = 86_400_000;

export const DEFAULT_RETENTION: RetentionPolicy = {
  checkout: 'immediate',
  'raw-command-logs': 30,
  'agent-transcript': 30,
  'review-artifacts': 30,
  'finding-metadata': 'while-installation-active',
  // Time-based cleanup is left to Langfuse's own retention setting; we only erase on uninstall.
  'llm-traces': 'while-installation-active',
  // From `finished_at`; only a growth bound (the console shows finished rows for ~5 minutes).
  'review-progress': 30,
  audit: 365,
};

/** Overrides can only shorten retention, never extend it. */
export function resolveRetention(overrides: Partial<RetentionPolicy> = {}): RetentionPolicy {
  const out = { ...DEFAULT_RETENTION };
  for (const key of Object.keys(DEFAULT_RETENTION) as RetentionClass[]) {
    const override = overrides[key];
    if (override === undefined) continue;
    out[key] = tighten(DEFAULT_RETENTION[key], override);
  }
  return out;
}

function tighten(def: RetentionRule, override: RetentionRule): RetentionRule {
  if (def === 'immediate') return 'immediate';
  if (typeof def === 'number') {
    if (typeof override === 'number') return Math.max(0, Math.min(def, override));
    if (override === 'immediate') return 'immediate';
    return def;
  }
  if (typeof override === 'number') return Math.max(0, override);
  if (override === 'immediate') return 'immediate';
  return def;
}

/** Epoch ms; null for while-installation-active (no time-based expiry). */
export function expiryAt(rule: RetentionRule, createdAtMs: number): number | null {
  if (rule === 'immediate') return createdAtMs;
  if (rule === 'while-installation-active') return null;
  return createdAtMs + rule * DAY_MS;
}

export function isExpired(rule: RetentionRule, createdAtMs: number, nowMs: number): boolean {
  const expiry = expiryAt(rule, createdAtMs);
  if (expiry === null) return false;
  return nowMs >= expiry;
}
