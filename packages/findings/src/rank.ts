import type { ChangeRelation } from '@reviewbot/domain';
import { CONFIRMATION_RANK, type ConfirmationLevel, type Severity } from './types.js';

/** Severity tiers are the primary sort key, not a multiplier: a low finding never outranks a medium one. */
const SEVERITY_TIER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** Must exceed the max in-tier quality score (1) so severity strictly dominates. */
const TIER_SPACING = 2;

/**
 * Severity ordinal for descending display order. Shares the tier table with `rankScore` so inline
 * quota allocation and display order agree.
 */
export function severityRank(severity: Severity): number {
  return SEVERITY_TIER[severity];
}

const MAX_CONFIRMATION_RANK = Math.max(...Object.values(CONFIRMATION_RANK));

const RELATION_WEIGHT: Record<ChangeRelation, number> = {
  introduced: 1,
  exposed: 0.9,
  regressed: 0.95,
  'preexisting-relevant': 0.6,
  'preexisting-unrelated': 0.3,
  unknown: 0.4,
};

export interface RankInput {
  severity: Severity;
  confirmation: ConfirmationLevel;
  changeRelation: ChangeRelation;
  actionable: boolean;
  anchorScore: number;
  /** 0..1; repeated issues are down-weighted. */
  novelty?: number;
}

/** Ranking score for ordering only; does not replace the publication matrix gates. */
export function rankScore(input: RankInput): number {
  // In-tier quality in [0,1].
  const quality =
    ((CONFIRMATION_RANK[input.confirmation] + 1) / (MAX_CONFIRMATION_RANK + 1)) *
    RELATION_WEIGHT[input.changeRelation] *
    (input.actionable ? 1 : 0.4) *
    clamp01(input.anchorScore) *
    clamp01(input.novelty ?? 1);
  return SEVERITY_TIER[input.severity] * TIER_SPACING + quality;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
