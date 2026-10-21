import type { Severity } from '@reviewbot/findings';

/** Thoroughness only; orthogonal to model tier (cost) and concurrency (latency). */
export type ReviewProfileName = 'conservative' | 'balanced' | 'thorough' | 'custom';

/** Deliberately excludes verification standards: a profile must never relax correctness/security checks. */
export interface ProfileSettings {
  /**
   * Running out of turns aborts the whole run (no finalization tool call), so turns are generous.
   * `maxToolCalls` is a soft limit (finalization still allowed) and is the real cost control.
   */
  exploreBudget: { maxTurns: number; maxToolCalls: number };
  /** Style, slop and other non-bug categories. */
  nonBugCategoriesEnabled: boolean;
  /**
   * Same for every profile: depth must not decide which results are shown. It is only a runaway cap;
   * noise is handled by ranking in `applyNoiseBudget`.
   */
  maxInlineComments: number;
  /** Separate from `maxInlineComments` so nits never take finding slots; overflow folds into the summary. */
  maxInlineNits: number;
  /** Non-critical categories below this severity are not published. */
  lowSeverityThreshold: Severity;
}

/** See `ProfileSettings.maxInlineComments`. */
const INLINE_COMMENT_BUDGET = 15;

const PROFILES: Record<Exclude<ReviewProfileName, 'custom'>, ProfileSettings> = {
  conservative: {
    exploreBudget: { maxTurns: 42, maxToolCalls: 24 },
    nonBugCategoriesEnabled: false,
    maxInlineComments: INLINE_COMMENT_BUDGET,
    maxInlineNits: 0,
    lowSeverityThreshold: 'high',
  },
  balanced: {
    exploreBudget: { maxTurns: 70, maxToolCalls: 40 },
    nonBugCategoriesEnabled: true,
    maxInlineComments: INLINE_COMMENT_BUDGET,
    maxInlineNits: 3,
    lowSeverityThreshold: 'medium',
  },
  thorough: {
    exploreBudget: { maxTurns: 112, maxToolCalls: 80 },
    nonBugCategoriesEnabled: true,
    maxInlineComments: INLINE_COMMENT_BUDGET,
    maxInlineNits: 6,
    lowSeverityThreshold: 'low',
  },
};

/** Categories whose verification standard no profile may lower. */
const VERIFICATION_CRITICAL: ReadonlySet<string> = new Set(['correctness', 'security']);

export function resolveProfile(name: ReviewProfileName, custom?: ProfileSettings): ProfileSettings {
  if (name === 'custom') {
    if (!custom) throw new Error('custom profile 需提供 ProfileSettings');
    return custom;
  }
  return PROFILES[name];
}

/** correctness/security are never suppressed by a profile. */
export function suppressedByThreshold(category: string, severity: Severity, settings: ProfileSettings): boolean {
  if (VERIFICATION_CRITICAL.has(category)) return false;
  return severityRank(severity) < severityRank(settings.lowSeverityThreshold);
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}
