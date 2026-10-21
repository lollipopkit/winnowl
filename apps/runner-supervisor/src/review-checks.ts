import {
  decideMergeGate,
  evaluateDeterministicChecks,
  type DeterministicSignals,
  type MergeGateConfig,
  type MergeGateReason,
} from '@reviewbot/checks';
import type { Db } from '@reviewbot/db';
import type { ChangeRequestRef } from '@reviewbot/domain';
import { loadChangeRequestBlockingFindings } from '@reviewbot/finding-lifecycle';
import type { ConfirmationLevel } from '@reviewbot/findings';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import type { ReviewRevisionContext } from './review-revision.js';
import { botMessages } from './locale.js';
import { loadRepositoryRef } from './repository-ref.js';

export interface ReviewChecksDeps {
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
  /** Merge gate override; omitted: loaded from the repo `merge_gate` config (off by default: never blocks). */
  mergeGate?: MergeGateConfig;
}

const DEFAULT_GATE: MergeGateConfig = { enabled: false, requiredConfirmation: 'independently-verified' };

/**
 * Submits the summary check run after a review. Non-review signals (title/tests/docs/approval) have no data
 * here and pass. With the gate off by default, the check only annotates and never blocks merging.
 */
export function createReviewChecksSubmitter(
  deps: ReviewChecksDeps,
): (outcome: ReviewOutcome, ctx: ReviewRevisionContext) => Promise<void> {
  return async (outcome, ctx) => {
    const provider = await deps.buildProvider(ctx.payload.repositoryId);
    /*
     * The blocking set is read from the database (findings are written before this), the same as the reverify
     * recompute; counting only this round's outcome would miss unfixed blocking findings from earlier rounds.
     */
    const blocking = await loadGateBlocking(ctx.db, ctx.payload.tenantId, ctx.payload.repositoryId, ctx.payload.changeRequestId);
    await submitReviewGateCheck({
      db: ctx.db,
      provider,
      tenantId: ctx.payload.tenantId,
      repositoryId: ctx.payload.repositoryId,
      changeRequestId: ctx.payload.changeRequestId,
      headSha: ctx.payload.headSha,
      blockingConfirmations: blocking.map((b) => b.confirmation),
      /*
       * Coverage is PR-wide, not per round: a complete round can still leave half the PR unseen.
       * `unreachedPaths` and `unplannedPaths` both count as gaps, as for approval (coverage.ts `plannedPathsOf`).
       * Without a usable ledger, falls back to this round's ratio.
       */
      coverageComplete:
        outcome.unreachedPaths !== undefined
          ? outcome.unreachedPaths.length === 0 &&
            (outcome.unplannedPaths?.length ?? 0) === 0 &&
            (outcome.deferredPaths?.length ?? 0) === 0
          : outcome.coverage.scopesComplete === outcome.coverage.scopesTotal,
      publishedInline: outcome.publishedInline,
      coverageGap: {
        unreached: outcome.unreachedPaths?.length ?? 0,
        unplanned: outcome.unplannedPaths?.length ?? 0,
        deferred: outcome.deferredPaths?.length ?? 0,
      },
      ...(deps.mergeGate ? { mergeGate: deps.mergeGate } : {}),
    });
  };
}

/** Shared core of the summary check run (review completion and reverify gate recompute). */
export interface GateCheckInput {
  db: Db;
  provider: SourceControlProvider;
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
  headSha: string;
  /** Confirmations of findings still blocking at this head (decideMergeGate input). */
  blockingConfirmations: string[];
  /** Whether review coverage is complete (reverify does not re-explore: true). */
  coverageComplete: boolean;
  /** Inline comments newly published (check title). */
  publishedInline: number;
  /**
   * Files in the coverage gap, written into the check summary even with `merge_gate` off, so the author
   * learns that part of the PR was not reviewed.
   */
  coverageGap?: { unreached: number; unplanned: number; deferred?: number };
  /** merge_gate override (omitted: loaded from repo config). */
  mergeGate?: MergeGateConfig;
}

/** Upserts the `winnowl/review` check run for the head's blocking set (keyed by headSha, idempotent). */
export async function submitReviewGateCheck(input: GateCheckInput): Promise<{ blocking: number; conclusion: 'success' | 'failure' | 'neutral' }> {
  const blockingFindings = input.blockingConfirmations.map((confirmation) => ({ confirmation: confirmation as ConfirmationLevel }));
  const signals: DeterministicSignals = {
    // Non-review metadata signals pass; missing data must not fail the check.
    hasTitleAndDescription: true,
    linkedIssue: true,
    requiredTestsPresent: true,
    requiredDocsPresent: true,
    requiredMigrationPresent: true,
    approvalsMet: true,
    unresolvedBlockingFindings: blockingFindings.length,
    reviewHealthComplete: input.coverageComplete,
  };
  const checks = evaluateDeterministicChecks(signals, input.headSha).filter((c) => c.id === 'no-unresolved-blocking' || c.id === 'review-health');
  const cfg = await loadEffectiveConfig(input.db, input.tenantId, input.repositoryId);
  const gate = input.mergeGate ?? { enabled: cfg.merge_gate.enabled, requiredConfirmation: cfg.merge_gate.minimum_confirmation };
  const decision = decideMergeGate({ config: gate ?? DEFAULT_GATE, checks, blockingFindings });
  const conclusion = decision.checkStatus === 'failure' ? 'failure' : decision.checkStatus === 'success' ? 'success' : 'neutral';
  const repo = await loadRepositoryRef(input.db, input.repositoryId);
  await input.provider.checks.createOrUpdate(
    repo,
    {
      name: 'winnowl/review',
      status: 'completed',
      conclusion,
      title: botMessages(cfg.language).checks.title({ blocking: blockingFindings.length, inline: input.publishedInline }),
      summary: [
        ...coverageLines(input.coverageGap, cfg.language),
        ...decision.reasons.map((r) => renderGateReason(r, cfg.language)),
      ].join('; '),
      headSha: input.headSha,
    },
    { key: `check:${input.changeRequestId}:${input.headSha}` },
  );
  // Neutral means the gate is off for this repo: the console shows no merge-check state.
  await input.db
    .updateTable('revisions')
    .set({
      gate_state: conclusion === 'failure' ? 'block' : conclusion === 'success' ? 'pass' : null,
      blocking_count: blockingFindings.length,
    })
    .where('tenant_id', '=', input.tenantId)
    .where('change_request_id', '=', input.changeRequestId)
    .where('head_sha', '=', input.headSha)
    .execute();
  return { blocking: blockingFindings.length, conclusion };
}

export interface RecomputeGateDeps {
  db: Db;
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
}

export interface RecomputeGateInput {
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
  headSha: string;
  crRef: ChangeRequestRef;
  /** Repo `reviews.auto_approve` (false: comment instead of approve even with zero blocking). */
  autoApprove: boolean;
}

/**
 * Recomputes the gate right after reverify changed the CR's blocking set: the check run is recomputed
 * from the CR-scoped blocking set, and a PR approve is sent only with zero blocking and an unmoved head.
 * Uses createReviewBatch directly (bypassing publishReviewBatch's revision idempotency) with its own key.
 */
export async function recomputeReviewGate(deps: RecomputeGateDeps, input: RecomputeGateInput): Promise<void> {
  // Approve only if the CR's latest revision is still at this head; otherwise the next review decides.
  const latest = await deps.db
    .selectFrom('revisions')
    .select('head_sha')
    .where('change_request_id', '=', input.changeRequestId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  const headCurrent = latest?.head_sha === input.headSha;

  const blocking = await loadGateBlocking(deps.db, input.tenantId, input.repositoryId, input.changeRequestId);
  const provider = await deps.buildProvider(input.repositoryId);

  await submitReviewGateCheck({
    db: deps.db,
    provider,
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    changeRequestId: input.changeRequestId,
    headSha: input.headSha,
    blockingConfirmations: blocking.map((b) => b.confirmation),
    coverageComplete: true,
    publishedInline: 0,
  });

  if (blocking.length === 0 && headCurrent && provider.discussions.createReviewBatch) {
    const event = input.autoApprove === false ? 'comment' : 'approve';
    await provider.discussions.createReviewBatch(input.crRef, { event, comments: [] }, { key: `reverify-gate:${input.changeRequestId}:${input.headSha}` });
  }
}

/**
 * Findings of this CR still blocking under the current `reviews.block_preexisting` and
 * `merge_gate.block_on_severity` config.
 */
async function loadGateBlocking(db: Db, tenantId: string, repositoryId: string, changeRequestId: string) {
  const cfg = await loadEffectiveConfig(db, tenantId, repositoryId);
  return loadChangeRequestBlockingFindings(db, changeRequestId, {
    blockPreexisting: cfg.reviews.block_preexisting,
    blockOnSeverity: cfg.merge_gate.block_on_severity,
  });
}

/**
 * Recomputes the gate from just the CR (`@bot ignore`), resolving head, CR coordinates and
 * `reviews.auto_approve` itself. A missing CR/revision returns silently; the next review recomputes it.
 */
export async function recomputeGateForChangeRequest(
  deps: RecomputeGateDeps,
  input: { tenantId: string; repositoryId: string; changeRequestId: string },
): Promise<void> {
  const cr = await deps.db
    .selectFrom('change_requests')
    .select(['id', 'repository_id', 'native_id', 'number', 'kind'])
    .where('id', '=', input.changeRequestId)
    .executeTakeFirst();
  if (!cr) return;
  const rev = await deps.db
    .selectFrom('revisions')
    .select('head_sha')
    .where('change_request_id', '=', input.changeRequestId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!rev) return;
  const cfg = await loadEffectiveConfig(deps.db, input.tenantId, input.repositoryId);
  await recomputeReviewGate(deps, {
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    changeRequestId: input.changeRequestId,
    headSha: rev.head_sha,
    crRef: {
      id: cr.id,
      repositoryId: cr.repository_id,
      nativeId: cr.native_id,
      number: cr.number,
      kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
    },
    autoApprove: cfg.reviews.auto_approve,
  });
}

function coverageLines(gap: GateCheckInput['coverageGap'], language?: string): string[] {
  const m = botMessages(language).checks;
  return [
    ...(gap && gap.unreached > 0 ? [m.coverageUnreached({ count: gap.unreached })] : []),
    ...(gap && gap.unplanned > 0 ? [m.coverageUnplanned({ count: gap.unplanned })] : []),
    ...(gap && (gap.deferred ?? 0) > 0 ? [m.coverageDeferred({ count: gap.deferred! })] : []),
  ];
}

/** Typed gate reason to localized text (the checks package emits only reasonCode). */
function renderGateReason(reason: MergeGateReason, language?: string): string {
  const m = botMessages(language).checks;
  switch (reason.code) {
    case 'gate-disabled':
      return m.gateDisabled();
    case 'blocking-findings':
      return m.gateBlockingFindings({ count: reason.count, level: reason.requiredConfirmation });
    case 'unknown-checks':
      return reason.blocking ? m.gateUnknownChecksBlocking({ count: reason.count }) : m.gateUnknownChecksIgnored({ count: reason.count });
    case 'failing-checks':
      return m.gateFailingChecks({ count: reason.count });
  }
}
