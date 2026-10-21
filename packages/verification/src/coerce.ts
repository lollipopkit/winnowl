import { CHANGE_RELATIONS, type ChangeRelation } from '@reviewbot/domain';
import type { ConfirmationLevel, Effort, Severity } from '@reviewbot/findings';

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const EFFORTS: readonly Effort[] = ['quick-win', 'heavy-lift'];
/**
 * Levels a verifier may self-report (not all of `ConfirmationLevel`: its tools are read-only, so
 * `tool-confirmed` would be just a claim). Anything else falls back to `code-supported`;
 * `clampSelfReportedConfirmation` separately caps what is allowed.
 */
export const CONFIRMATIONS: readonly ConfirmationLevel[] = [
  'hypothesis',
  'code-supported',
  'independently-verified',
];

export function coerce<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function coerceChangeRelation(value: string): ChangeRelation {
  return coerce(value, CHANGE_RELATIONS, 'unknown');
}
