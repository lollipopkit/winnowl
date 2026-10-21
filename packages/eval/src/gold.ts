import type { EvalFinding, EvalSeverity } from './types.js';

export interface CodeRabbitComment {
  path: string;
  line?: number;
  body: string;
}

/**
 * CodeRabbit's own first-line label, e.g. `_🎯 Functional Correctness_ | _🟠 Major_ | _⚡ Quick win_`
 * (category | severity | effort). The effort part is not parsed.
 */
const CR_LABEL_RE = /^_[^_]*?\s([A-Za-z][A-Za-z &]*[A-Za-z])_\s*\|\s*_[^_]*?\s(\w+)_/;

const CR_CATEGORY_MAP: Record<string, string> = {
  'functional correctness': 'correctness',
  'security & privacy': 'security',
  'security and privacy': 'security',
  'stability & availability': 'reliability',
  'stability and availability': 'reliability',
  performance: 'performance',
  maintainability: 'maintainability',
  style: 'style',
  'test coverage': 'test-gap',
  compatibility: 'compatibility',
  concurrency: 'concurrency',
  'data integrity': 'data-integrity',
  'error handling': 'error-handling',
};

/** Hard-coded to avoid depending on packages/findings. */
const FINDING_CATEGORIES = [
  'correctness', 'security', 'authorization', 'concurrency', 'data-integrity', 'resource-lifetime',
  'error-handling', 'compatibility', 'migration', 'performance', 'reliability', 'test-gap',
  'build-deployment', 'maintainability', 'style',
];

const CR_SEVERITY_MAP: Record<string, EvalSeverity> = {
  critical: 'critical',
  blocker: 'critical',
  major: 'high',
  minor: 'medium',
  trivial: 'low',
  nit: 'low',
};

function parseCodeRabbitLabel(body: string): { category: string; severity: EvalSeverity } | null {
  const firstLine = body.split('\n', 1)[0] ?? '';
  const m = CR_LABEL_RE.exec(firstLine);
  if (!m) return null;
  const rawCategory = (m[1] ?? '').trim().toLowerCase();
  const rawSeverity = (m[2] ?? '').trim().toLowerCase();
  const severity = CR_SEVERITY_MAP[rawSeverity];
  if (!severity) return null;
  const mapped = CR_CATEGORY_MAP[rawCategory];
  if (mapped) return { category: mapped, severity };
  // Unknown category name: accept it only if it names one of our categories.
  const loose = FINDING_CATEGORIES.find((c) => rawCategory.includes(c.replace('-', ' ')));
  return loose ? { category: loose, severity } : null;
}

/** Keyword fallback, used only when there is no label. */
const MARKERS: { re: RegExp; category: string; severity: EvalSeverity }[] = [
  { re: /potential issue|possible bug|logic error|off-by-one|null|race condition/i, category: 'correctness', severity: 'high' },
  { re: /security|injection|vulnerab|secret|hardcoded|auth(oriz|entic)/i, category: 'security', severity: 'high' },
  // Must be a production FindingCategory, or matchFinding can never match.
  { re: /performance|inefficient|n\+1|memory leak/i, category: 'performance', severity: 'medium' },
  { re: /refactor suggestion|maintainab|complexity|duplicat/i, category: 'maintainability', severity: 'low' },
  { re: /nitpick|style|typo|formatting|naming/i, category: 'style', severity: 'info' },
];

/** Label first, then keyword fallback; null when neither matches. */
export function parseCodeRabbitFinding(comment: CodeRabbitComment): EvalFinding | null {
  if (!comment.path) return null;
  const body = comment.body;
  const labeled = parseCodeRabbitLabel(body);
  if (labeled) return { ...labeled, path: comment.path };
  for (const m of MARKERS) {
    if (m.re.test(body)) {
      return { category: m.category, severity: m.severity, path: comment.path };
    }
  }
  return null;
}

export function parseCodeRabbitGold(comments: CodeRabbitComment[]): EvalFinding[] {
  return comments.map(parseCodeRabbitFinding).filter((f): f is EvalFinding => f !== null);
}
