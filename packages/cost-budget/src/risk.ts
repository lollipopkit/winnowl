import type { AdaptInput, HighRiskFactor, LowRiskFactor } from './types.js';

const HIGH_RISK_STEP = 0.25;
const HIGH_RISK_CAP = 3;
const LOW_RISK_FACTOR = 0.5;
const LOW_RISK_FLOOR = 0.25;

/**
 * High risk wins: +25% per factor, capped at 3x; only without high risk does low risk scale by 0.5x
 * (floor 0.25x). Shared by `adaptBudget` and review-runtime's turn/tool-call scaling.
 */
export function computeRiskFactor(input: AdaptInput): number {
  const high = input.highRisk ?? [];
  const low = input.lowRisk ?? [];
  if (high.length > 0) return Math.min(HIGH_RISK_CAP, 1 + HIGH_RISK_STEP * high.length);
  if (low.length > 0) return Math.max(LOW_RISK_FLOOR, LOW_RISK_FACTOR);
  return 1;
}

/** Changed-file count that counts as a large-refactor high-risk factor. */
const LARGE_REFACTOR_FILES = 25;

/** Path-only heuristics; content-based factors (concurrency etc.) are not decided here. */
const HIGH_RISK_PATTERNS: { factor: HighRiskFactor; re: RegExp }[] = [
  { factor: 'auth-security', re: /(^|\/)(auth|security|login|passwd|password|secret|token|crypto|rbac|acl|permission|oauth|jwt|session)s?[./_-]/i },
  { factor: 'migration', re: /(^|\/)migrations?\/|(^|\/)[0-9]{3,}[._-].*\.sql$|\bschema\.sql$/i },
  { factor: 'public-api', re: /(^|\/)(openapi|swagger)\b|\.proto$|(^|\/)api\/(v\d+|public)\//i },
  { factor: 'dependency-major-upgrade', re: /(^|\/)(package\.json|pnpm-lock\.yaml|go\.mod|go\.sum|Cargo\.toml|requirements\.txt|pyproject\.toml|pom\.xml|build\.gradle)$/i },
];

const LOW_RISK_PATTERNS: { factor: LowRiskFactor; re: RegExp }[] = [
  { factor: 'docs', re: /\.(md|mdx|rst|txt)$|(^|\/)docs?\//i },
  { factor: 'generated-code', re: /(^|\/)(dist|build|out|node_modules)\/|\.(gen|g)\.[a-z]+$|\.pb\.[a-z]+$|_pb2\.py$|\.min\.[a-z]+$|generated/i },
];

/** Factors are deduplicated; content-only factors (concurrency/linked-incident) come from the caller. */
export function classifyChangeRisk(files: readonly { path: string }[]): AdaptInput {
  const high = new Set<HighRiskFactor>();
  const low = new Set<LowRiskFactor>();
  for (const { path } of files) {
    for (const { factor, re } of HIGH_RISK_PATTERNS) if (re.test(path)) high.add(factor);
    for (const { factor, re } of LOW_RISK_PATTERNS) if (re.test(path)) low.add(factor);
  }
  if (files.length >= LARGE_REFACTOR_FILES) high.add('large-refactor');
  return { highRisk: [...high], lowRisk: [...low] };
}
