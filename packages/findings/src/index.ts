/** @reviewbot/findings: publication policy (matrix, suppression, ranking, noise budget). */

export type {
  FindingCategory,
  Severity,
  Effort,
  ConfirmationLevel,
  SuppressionReason,
  PublicationStatus,
  PublicationKind,
  PublicationPlacement,
  DemotionReason,
  SuppressReason,
} from './types.js';
export {
  CONFIRMATION_RANK,
  MAX_SELF_REPORTED_CONFIRMATION,
  clampSelfReportedConfirmation,
  HIGH_RISK_SEVERITIES,
  isAtLeast,
  isHighRiskSeverity,
  NON_BLOCKING_CATEGORIES,
  shouldPublish,
} from './types.js';

export { DEFAULT_BLOCK_ON_SEVERITY, blocksMerge, decidePublication, isNitpick } from './matrix.js';
export type { BlockingFacts, BlockScope, PublicationInput, PublicationDecision, VerifierDecision } from './matrix.js';

export { rankScore, severityRank } from './rank.js';
export type { RankInput } from './rank.js';

export { applyNoiseBudget } from './noise-budget.js';
export type { NoiseItem, NoiseBudget, NoiseResult } from './noise-budget.js';
