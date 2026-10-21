export type FindingCategory =
  | 'correctness'
  | 'security'
  | 'authorization'
  | 'concurrency'
  | 'data-integrity'
  | 'resource-lifetime'
  | 'error-handling'
  | 'compatibility'
  | 'migration'
  | 'performance'
  | 'reliability'
  | 'test-gap'
  | 'build-deployment'
  | 'maintainability'
  | 'style';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Fix cost; helps authors prioritise, never affects placement or gating. */
export type Effort = 'quick-win' | 'heavy-lift';

/**
 * Every level must have a producer. The first three are self-reported by the verifier;
 * `tool-confirmed` only comes from deterministic tools (dependency scanners), never the model.
 */
export type ConfirmationLevel =
  | 'hypothesis'
  | 'code-supported'
  | 'independently-verified'
  | 'tool-confirmed';

export const CONFIRMATION_RANK: Record<ConfirmationLevel, number> = {
  hypothesis: 0,
  'code-supported': 1,
  'independently-verified': 2,
  'tool-confirmed': 3,
};

/**
 * Cap on self-reported confirmation. The verifier has read-only tools, so anything above
 * `independently-verified` would be an unbacked claim.
 */
export const MAX_SELF_REPORTED_CONFIRMATION: ConfirmationLevel = 'independently-verified';

export function clampSelfReportedConfirmation(level: ConfirmationLevel): ConfirmationLevel {
  return CONFIRMATION_RANK[level] > CONFIRMATION_RANK[MAX_SELF_REPORTED_CONFIRMATION]
    ? MAX_SELF_REPORTED_CONFIRMATION
    : level;
}

export function isAtLeast(level: ConfirmationLevel, min: ConfirmationLevel): boolean {
  return CONFIRMATION_RANK[level] >= CONFIRMATION_RANK[min];
}

export type SuppressionReason =
  | 'duplicate'
  | 'preexisting-unrelated'
  | 'low-evidence'
  | 'unreachable'
  | 'not-actionable'
  | 'style-only'
  | 'better-root-cause'
  | 'already-covered-by-ci'
  | 'anchor-ambiguous'
  | 'noise-budget'
  | 'repository-learning'
  | 'user-dismissed-pattern'
  | 'outdated-revision'
  | 'unsupported-provider-location';

// Status, kind and placement are orthogonal axes so demotions cannot overwrite status or kind.

/**
 * - `confirmed`: verified and above the severity's confirmation threshold;
 * - `uncertain`: not verified; shown as a lead (no severity badge, not in agent fix prompts, never blocking);
 * - `refuted`: verified false or not actionable; stored, not shown.
 */
export type PublicationStatus = 'confirmed' | 'uncertain' | 'refuted';

/** Formal defect or polish suggestion; independent of status and placement. */
export type PublicationKind = 'defect' | 'nit';

/** Inline diff comment or folded into the summary. Demotions only change this axis. */
export type PublicationPlacement = 'inline' | 'folded';

export function shouldPublish(status: PublicationStatus): boolean {
  return status !== 'refuted';
}

/** Unconfirmed findings at these severities get their own "Unverified risks" section. */
export const HIGH_RISK_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(['critical', 'high']);

export function isHighRiskSeverity(severity: Severity): boolean {
  return HIGH_RISK_SEVERITIES.has(severity);
}

/**
 * Why a finding was demoted from inline to folded; accumulated in order. Stored rows may still
 * contain the removed `'low-severity'` value, which renderers treat as a plain string.
 */
export type DemotionReason =
  /** Matrix: anchor not unique or score too low. */
  | 'anchor-unreliable'
  /** Matrix: below `publication.min_confirmation`. */
  | 'below-min-confirmation'
  /** Profile: non-defect (slop) folded. */
  | 'slop-folded'
  /** Recurrence: already inlined in an earlier round. */
  | 'previously-reported'
  /** Over this review's inline quota (`maxInlineComments` / `maxInlineNits`). */
  | 'inline-budget'
  /** Over `maxInlinePerFile`. */
  | 'per-file-budget'
  /** Anchor resolution failed. */
  | 'no-anchor'
  /** Anchor outside the changed lines; providers reject the whole review for such lines. */
  | 'anchor-outside-diff'
  /** Deterministic dependency-scan result; bypasses the matrix and is always folded. */
  | 'dependency-evidence';

/** Why a verified finding was not posted at all (first matching cause). */
export type SuppressReason =
  | 'duplicate'
  | 'slop'
  | 'below-threshold'
  | 'not-confirmed'
  | 'unrelated'
  | 'dismissed'
  | 'quota';

/** Categories that are non-blocking by default. */
export const NON_BLOCKING_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  'test-gap',
  'maintainability',
  'style',
]);
