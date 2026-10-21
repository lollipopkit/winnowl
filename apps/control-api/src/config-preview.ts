import type { EffectiveRepositoryConfig as RepositoryConfig } from '@reviewbot/config';
import { sql, type Db } from '@reviewbot/db';
import type { ChangeRelation } from '@reviewbot/domain';
import {
  applyNoiseBudget,
  blocksMerge,
  isAtLeast,
  isNitpick,
  rankScore,
  type ConfirmationLevel,
  type FindingCategory,
  type Severity,
} from '@reviewbot/findings';
import { isSlopKind, resolveProfile, suppressedByThreshold } from '@reviewbot/review-profile';

/**
 * Replays the settings-dependent publication rules over the latest review's stored occurrences.
 * Verifier decisions, anchor scores and ranks are not stored, so this is an estimate: inline
 * eligibility comes from the recorded demotions and rank is rebuilt with a perfect anchor score.
 */
export interface ConfigPreview {
  basis: { revisionId: string; changeNumber: number; candidates: number } | null;
  inline: number;
  summary: number;
  notPosted: number;
  /** null when the setting hides them. */
  unverifiedRisks: number | null;
  unrelated: { count: number; mode: 'summary' | 'issue' | 'off' };
  blocking: number;
  gate: 'block' | 'pass' | 'off';
}

/** Suppressions that depend only on the review itself, never on these settings. */
const FIXED_SUPPRESSIONS = new Set(['duplicate', 'not-confirmed', 'dismissed']);
const BUDGET_DEMOTIONS = new Set(['inline-budget', 'per-file-budget']);

interface OccurrenceFacts {
  id: string;
  state: string;
  severity: Severity;
  category: string;
  changeRelation: ChangeRelation;
  confirmation: ConfirmationLevel;
  refuterUpheld: boolean | null;
  suppressReason: string | null;
  demotions: string[];
  path: string;
}

export async function previewConfig(
  db: Db,
  tenantId: string,
  repositoryId: string,
  config: RepositoryConfig,
): Promise<ConfigPreview> {
  const latest = await db
    .selectFrom('review_costs as rc')
    .innerJoin('revisions as r', 'r.id', 'rc.revision_id')
    .innerJoin('change_requests as cr', 'cr.id', 'r.change_request_id')
    .select(['rc.revision_id', 'rc.candidate_count', 'cr.number'])
    .where('rc.tenant_id', '=', tenantId)
    .where('rc.repository_id', '=', repositoryId)
    .where('rc.cancelled', '=', false)
    .orderBy('rc.created_at', 'desc')
    .executeTakeFirst();
  const rows = latest
    ? await db
        .selectFrom('finding_occurrences as o')
        .innerJoin('findings as f', 'f.id', 'o.finding_id')
        .select([
          'o.id',
          'o.state',
          'o.severity',
          'o.change_relation',
          'o.confirmation',
          'o.refuter_upheld',
          'o.suppress_reason',
          'o.demotions',
          'f.category',
          sql<string | null>`o.anchor ->> 'path'`.as('path'),
        ])
        .where('o.tenant_id', '=', tenantId)
        .where('o.revision_id', '=', latest.revision_id)
        .execute()
    : [];
  return planPreview(
    config,
    rows.map((r) => ({
      id: r.id,
      state: r.state,
      severity: r.severity as Severity,
      category: r.category,
      changeRelation: r.change_relation as ChangeRelation,
      confirmation: r.confirmation as ConfirmationLevel,
      refuterUpheld: r.refuter_upheld,
      suppressReason: r.suppress_reason,
      demotions: Array.isArray(r.demotions) ? (r.demotions as string[]) : [],
      path: r.path ?? '',
    })),
    latest ? { revisionId: latest.revision_id, changeNumber: latest.number, candidates: latest.candidate_count } : null,
  );
}

export function planPreview(
  config: RepositoryConfig,
  occurrences: OccurrenceFacts[],
  basis: ConfigPreview['basis'],
): ConfigPreview {
  const profile = resolveProfile(config.reviews.profile);
  const publication = config.reviews.publication;
  const unrelatedMode = config.reviews.scope.report_preexisting_unrelated;
  const scope = { blockOnSeverity: config.merge_gate.block_on_severity, blockPreexisting: config.reviews.block_preexisting };

  let summary = 0;
  let notPosted = 0;
  let unrelated = 0;
  let blocking = 0;
  let unverified = 0;
  const inlineCandidates: (OccurrenceFacts & { blocking: boolean })[] = [];

  for (const o of occurrences) {
    if (o.state === 'unverified-risks') {
      unverified += 1;
      continue;
    }
    const confirmed =
      o.state === 'inline' ||
      o.state === 'summary' ||
      (o.state === 'suppressed' &&
        !FIXED_SUPPRESSIONS.has(o.suppressReason ?? '') &&
        isAtLeast(o.confirmation, 'independently-verified'));
    if (!confirmed) {
      notPosted += 1;
      continue;
    }
    const slop = isSlopKind(o.category);
    if (
      (slop && !profile.nonBugCategoriesEnabled) ||
      (!slop && suppressedByThreshold(o.category, o.severity, profile))
    ) {
      notPosted += 1;
      continue;
    }
    if (o.changeRelation === 'preexisting-unrelated') {
      unrelated += 1;
      if (unrelatedMode === 'summary') summary += 1;
      else notPosted += 1;
      continue;
    }
    const facts = { ...o, category: o.category as FindingCategory, refuterUpheld: o.refuterUpheld ?? false };
    const blocks = !slop && blocksMerge(facts, scope);
    if (blocks) blocking += 1;
    const inlineTrack = !slop && (o.demotions.length === 0 || BUDGET_DEMOTIONS.has(o.demotions[0]!));
    if (inlineTrack && isAtLeast(o.confirmation, publication.min_confirmation)) inlineCandidates.push({ ...o, blocking: blocks });
    else summary += 1;
  }

  const budget = applyNoiseBudget(
    inlineCandidates.map((o) => ({
      id: o.id,
      kind: isNitpick({ severity: o.severity, category: o.category as FindingCategory }) ? 'nit' : 'defect',
      file: o.path,
      rank: rankScore({
        severity: o.severity,
        confirmation: o.confirmation,
        changeRelation: o.changeRelation,
        actionable: true,
        anchorScore: 1,
      }),
    })),
    {
      maxInlineComments: publication.max_inline_comments ?? profile.maxInlineComments,
      maxInlinePerFile: publication.max_inline_per_file ?? 3,
      maxInlineNits: publication.max_inline_nitpicks ?? profile.maxInlineNits,
    },
  );
  let inline = 0;
  budget.forEach((b, i) => {
    if (!b.overflow) inline += 1;
    // Blocking findings are never dropped for quota.
    else if (publication.summary_overflow || inlineCandidates[i]!.blocking) summary += 1;
    else notPosted += 1;
  });

  return {
    basis,
    inline,
    summary,
    notPosted,
    unverifiedRisks: publication.show_unverified_risks ? unverified : null,
    unrelated: { count: unrelated, mode: unrelatedMode },
    blocking,
    gate: config.merge_gate.enabled ? (blocking > 0 ? 'block' : 'pass') : 'off',
  };
}
