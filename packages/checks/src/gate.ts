import { isAtLeast, type ConfirmationLevel } from '@reviewbot/findings';
import type { CheckResult, MergeGateConfig } from './types.js';

export interface MergeGateInput {
  config: MergeGateConfig;
  checks: CheckResult[];
  blockingFindings: { confirmation: ConfirmationLevel }[];
}

/** Typed so the presentation layer localizes it; this package has no user-facing text. */
export type MergeGateReason =
  | { code: 'gate-disabled' }
  | { code: 'blocking-findings'; count: number; requiredConfirmation: ConfirmationLevel }
  | { code: 'unknown-checks'; count: number; blocking: boolean }
  | { code: 'failing-checks'; count: number };

export interface MergeGateDecision {
  checkStatus: 'neutral' | 'success' | 'failure';
  /** Never by default; merge governance decides separately. */
  requestChanges: boolean;
  reasons: MergeGateReason[];
}

/**
 * Disabled by default (never requests changes). When enabled, only blocking findings at the
 * configured confirmation level fail the gate; unknown does not block by default.
 */
export function decideMergeGate(input: MergeGateInput): MergeGateDecision {
  const { config, checks, blockingFindings } = input;
  const hasNonPass = checks.some((c) => c.status !== 'pass');

  if (!config.enabled) {
    return {
      checkStatus: hasNonPass ? 'neutral' : 'success',
      requestChanges: false,
      reasons: [{ code: 'gate-disabled' }],
    };
  }

  const reasons: MergeGateReason[] = [];
  const qualifyingFindings = blockingFindings.filter((f) => isAtLeast(f.confirmation, config.requiredConfirmation));
  if (qualifyingFindings.length > 0) {
    reasons.push({ code: 'blocking-findings', count: qualifyingFindings.length, requiredConfirmation: config.requiredConfirmation });
  }

  const unknownChecks = checks.filter((c) => c.status === 'unknown');
  const blockOnUnknown = config.blockOnUnknown ?? false;
  if (unknownChecks.length > 0) {
    reasons.push({ code: 'unknown-checks', count: unknownChecks.length, blocking: blockOnUnknown });
  }

  const failingChecks = checks.filter((c) => c.status === 'fail');
  if (failingChecks.length > 0) reasons.push({ code: 'failing-checks', count: failingChecks.length });

  const fail =
    qualifyingFindings.length > 0 ||
    failingChecks.length > 0 ||
    (blockOnUnknown && unknownChecks.length > 0);

  return {
    checkStatus: fail ? 'failure' : 'success',
    // A failed check alone never requests changes; that is the policy engine's call.
    requestChanges: false,
    reasons,
  };
}
