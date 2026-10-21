import type { EvalFinding, EvalSeverity } from './types.js';

export type { EvalFinding, EvalSeverity } from './types.js';

export interface CaseResult {
  caseId: string;
  expected: EvalFinding[];
  produced: EvalFinding[];
}

export interface SeverityMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
}

export interface Metrics extends SeverityMetrics {
  bySeverity: Record<EvalSeverity, SeverityMetrics>;
}

/** Same path and category. */
export function matchFinding(expected: EvalFinding, produced: EvalFinding): boolean {
  return expected.path === produced.path && expected.category === produced.category;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function metricsFrom(tp: number, fp: number, fn: number): SeverityMetrics {
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, tp + fp),
  };
}

const SEVERITIES: EvalSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** False-positive rates are grouped by the produced severity, matching the release gate. */
export function computeMetrics(results: CaseResult[]): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const bySev: Record<EvalSeverity, { tp: number; fp: number; fn: number }> = {
    critical: { tp: 0, fp: 0, fn: 0 },
    high: { tp: 0, fp: 0, fn: 0 },
    medium: { tp: 0, fp: 0, fn: 0 },
    low: { tp: 0, fp: 0, fn: 0 },
    info: { tp: 0, fp: 0, fn: 0 },
  };

  for (const result of results) {
    const expectedMatched = new Set<number>();
    for (const produced of result.produced) {
      const idx = result.expected.findIndex((e, i) => !expectedMatched.has(i) && matchFinding(e, produced));
      if (idx >= 0) {
        expectedMatched.add(idx);
        tp += 1;
        bySev[produced.severity].tp += 1;
      } else {
        fp += 1;
        bySev[produced.severity].fp += 1;
      }
    }
    result.expected.forEach((e, i) => {
      if (!expectedMatched.has(i)) {
        fn += 1;
        bySev[e.severity].fn += 1;
      }
    });
  }

  const bySeverity = {} as Record<EvalSeverity, SeverityMetrics>;
  for (const sev of SEVERITIES) {
    bySeverity[sev] = metricsFrom(bySev[sev].tp, bySev[sev].fp, bySev[sev].fn);
  }
  return { ...metricsFrom(tp, fp, fn), bySeverity };
}

export interface AcceptanceThresholds {
  maxHighCriticalFpRate: number;
  maxOverallFpRate: number;
}

export const DEFAULT_THRESHOLDS: AcceptanceThresholds = {
  maxHighCriticalFpRate: 0.02,
  maxOverallFpRate: 0.08,
};

export interface ThresholdCheck {
  pass: boolean;
  violations: string[];
}

export function checkThresholds(metrics: Metrics, thresholds: AcceptanceThresholds = DEFAULT_THRESHOLDS): ThresholdCheck {
  const violations: string[] = [];
  const highCriticalFp = metrics.bySeverity.critical.falsePositives + metrics.bySeverity.high.falsePositives;
  const highCriticalTotal =
    highCriticalFp + metrics.bySeverity.critical.truePositives + metrics.bySeverity.high.truePositives;
  const highCriticalFpRate = ratio(highCriticalFp, highCriticalTotal);

  if (highCriticalFpRate > thresholds.maxHighCriticalFpRate) {
    violations.push(`high/critical FP rate ${(highCriticalFpRate * 100).toFixed(1)}% > ${(thresholds.maxHighCriticalFpRate * 100).toFixed(0)}%`);
  }
  if (metrics.falsePositiveRate > thresholds.maxOverallFpRate) {
    violations.push(`overall FP rate ${(metrics.falsePositiveRate * 100).toFixed(1)}% > ${(thresholds.maxOverallFpRate * 100).toFixed(0)}%`);
  }
  return { pass: violations.length === 0, violations };
}

export interface ReleaseGateThresholds extends AcceptanceThresholds {
  minAnchorResolutionRate: number;
}

export const DEFAULT_RELEASE_THRESHOLDS: ReleaseGateThresholds = {
  ...DEFAULT_THRESHOLDS,
  minAnchorResolutionRate: 0.99,
};

export interface ReleaseGateSignals {
  anchorResolutionRate: number;
  /** Duplicate publications under fault injection (must be 0). */
  duplicatePublications: number;
  /** Must be 0. */
  sandboxLeaks: number;
  providerContractPass: boolean;
  coverageHonest: boolean;
  /** Per category so security/concurrency are not hidden by the total. */
  categoryRecall: Record<string, number>;
  minCategoryRecall: Record<string, number>;
}

export interface ReleaseGateResult {
  pass: boolean;
  violations: string[];
}

export function evaluateReleaseGate(
  metrics: Metrics,
  signals: ReleaseGateSignals,
  thresholds: ReleaseGateThresholds = DEFAULT_RELEASE_THRESHOLDS,
): ReleaseGateResult {
  const violations = [...checkThresholds(metrics, thresholds).violations];

  if (signals.anchorResolutionRate < thresholds.minAnchorResolutionRate) {
    violations.push(`anchor resolution ${(signals.anchorResolutionRate * 100).toFixed(1)}% < ${(thresholds.minAnchorResolutionRate * 100).toFixed(0)}%`);
  }
  if (signals.duplicatePublications !== 0) {
    violations.push(`duplicate publications ${signals.duplicatePublications} ≠ 0`);
  }
  if (signals.sandboxLeaks !== 0) {
    violations.push(`sandbox leaks ${signals.sandboxLeaks} ≠ 0`);
  }
  if (!signals.providerContractPass) violations.push('provider contract not fully passing');
  if (!signals.coverageHonest) violations.push('coverage not honestly reported');

  for (const [category, min] of Object.entries(signals.minCategoryRecall)) {
    const actual = signals.categoryRecall[category] ?? 0;
    if (actual < min) {
      violations.push(`${category} recall ${(actual * 100).toFixed(1)}% < ${(min * 100).toFixed(0)}%`);
    }
  }

  return { pass: violations.length === 0, violations };
}

export { parseCodeRabbitFinding, parseCodeRabbitGold } from './gold.js';
export type { CodeRabbitComment } from './gold.js';

export { codeRabbitCommentsFrom, goldFromReviewComments, groupCodeRabbitCommentsByCommit } from './github-gold.js';
export type { GhReviewComment } from './github-gold.js';
