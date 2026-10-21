import { isAtLeast, type Severity } from '@reviewbot/findings';
import type { AutoIssueDecision, AutoIssueConfig, AutoIssueFinding } from './types.js';

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export interface AutoIssueContext {
  config: AutoIssueConfig;
  /** Fingerprints that already have an issue. */
  existingFingerprints: ReadonlySet<string>;
}

/**
 * Only preexisting-unrelated findings at or above the minimum confirmation and severity,
 * deduplicated against existing issues and capped per review.
 */
export function decideAutoIssues(findings: AutoIssueFinding[], ctx: AutoIssueContext): AutoIssueDecision {
  const create: AutoIssueDecision['create'] = [];
  const skipped: AutoIssueDecision['skipped'] = [];

  if (!ctx.config.enabled) {
    return { create: [], skipped: findings.map((f) => ({ findingId: f.findingId, reason: '自动建 Issue 未开启' })) };
  }

  const minConfirmation = ctx.config.minConfirmation ?? 'independently-verified';
  const label = ctx.config.label ?? 'ai-found';

  const eligible: AutoIssueFinding[] = [];
  for (const f of findings) {
    if (f.changeRelation !== 'preexisting-unrelated') {
      skipped.push({ findingId: f.findingId, reason: '非 preexisting-unrelated' });
      continue;
    }
    if (!isAtLeast(f.confirmation, minConfirmation)) {
      skipped.push({ findingId: f.findingId, reason: `确认等级不足(需 ≥ ${minConfirmation})` });
      continue;
    }
    if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[ctx.config.minSeverity]) {
      skipped.push({ findingId: f.findingId, reason: `严重度不足(需 ≥ ${ctx.config.minSeverity})` });
      continue;
    }
    if (ctx.existingFingerprints.has(f.fingerprint)) {
      skipped.push({ findingId: f.findingId, reason: '已存在对应 Issue(去重)' });
      continue;
    }
    eligible.push(f);
  }

  // Highest severity first; dedupe fingerprints within the batch.
  eligible.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
  const seen = new Set<string>();
  for (const f of eligible) {
    if (seen.has(f.fingerprint)) {
      skipped.push({ findingId: f.findingId, reason: '本批重复指纹' });
      continue;
    }
    if (create.length >= ctx.config.maxPerReview) {
      skipped.push({ findingId: f.findingId, reason: `超出每次 Review 上限(${ctx.config.maxPerReview})` });
      continue;
    }
    seen.add(f.fingerprint);
    create.push({
      findingId: f.findingId,
      title: `[${f.severity}] ${f.title}`,
      body: renderIssueBody(f),
      labels: [label],
    });
  }

  return { create, skipped };
}

/**
 * Evidence summary + permalink only; private artifact content is never embedded.
 * The "Auto-filed by" footer is localized by the publisher.
 */
function renderIssueBody(f: AutoIssueFinding): string {
  return [f.evidenceSummary, '', `Evidence: ${f.evidencePermalink}`].join('\n');
}
