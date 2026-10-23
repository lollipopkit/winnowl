import { isBotActor, type ChangeRequestRef } from '@reviewbot/domain';
import { createProgressReporter } from './review-progress.js';
import { uuidv7 } from '@reviewbot/ids';
import { isRetryableFailure } from '@reviewbot/queue';
import { withLlmTraceContext } from '@reviewbot/telemetry';
import {
  runReviewAndPublish,
  publishReview,
  type ReviewOrchestratorDeps,
  type ReviewOutcome,
} from '@reviewbot/review-orchestrator';
import {
  loadEffectiveConfig,
  resolveStackRootTargetBranch,
  type ReviewEnv,
} from '@reviewbot/review-runtime';
import { sql } from '@reviewbot/db';
import { canRunReviewInSandbox, runReviewInSandbox } from './review-in-sandbox.js';
import { actionsExecutorImage } from '@reviewbot/runner-protocol';
import { ActionsRunCancelledError, runReviewInActions } from './review-in-actions.js';
import { RunnerSetupError } from './executor-error.js';
import { autoReviewSkip, countReviewablePaths } from './auto-review-gate.js';
import type { AutoReviewSkip } from './status-comment.js';
import { reviewSandboxResources } from './sandbox-backend.js';
import type { LlmRelayClient } from './llm-relay.js';
import {
  classifyJobError,
  JobExecutionError,
  throwIfInterrupted,
  type JobHandler,
  type JobHandlerDb,
} from './supervisor.js';

/** Throttles cancellation checks, which the orchestrator makes before every billable step. */
const CANCEL_POLL_INTERVAL_MS = 3_000;

export interface ReviewRevisionPayload {
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
  revisionId: string;
  headSha: string;
  configDigest: string;
  /**
   * `manual` = explicit user command; absent = webhook. Manual bypasses the auto-only gates and
   * resets the pause window.
   */
  trigger?: 'manual';
  /** `@bot full-review` bypasses file-state reuse and explores the whole filtered PR. */
  forceFullReview?: boolean;
  /** Platform user id of the initiator, for user-level plugin BYOK. */
  initiatedByUserId?: string;
  /** Set on rounds started by the previous round of the same head (review-continue.ts). */
  continueRound?: number;
}

export type { ReviewEnv };

export interface ReviewRevisionContext {
  payload: ReviewRevisionPayload;
  changeRequest: ChangeRequestRef;
  providerHostId: string;
  db: JobHandlerDb;
  /** Filled in by buildEnv; defaults to platform. */
  modelSourceKind?: 'platform' | 'byok';
}

/**
 * Why a review was blocked. Defined here rather than in review-ack to avoid an import cycle.
 * `cost_quota` (billing-period cap) and `daily_cost_cap` (resets at UTC midnight) recover
 * differently, so their messages must differ.
 */
export type ReviewBlockReason =
  'cost_quota' | 'review_quota' | 'token_quota' | 'daily_cost_cap' | 'other';

export interface ReviewRevisionDeps {
  buildEnv: (ctx: ReviewRevisionContext) => Promise<ReviewEnv>;
  /** Model relay for sandboxed reviews (no key enters a sandbox); see `RunInSandboxDeps.relay`. */
  llmRelay?: LlmRelayClient;
  /** Sandboxes run on sandbox hosts: refuse to sandbox a review without the relay. */
  requireLlmRelay?: boolean;
  newId?: () => string;
  onOutcome?: (outcome: ReviewOutcome, ctx: ReviewRevisionContext) => Promise<void>;
  /**
   * Bookkeeping only after a supersede: usage is still billed, but post-publication steps are
   * skipped since they need a complete, published result.
   */
  onCancelled?: (outcome: ReviewOutcome, ctx: ReviewRevisionContext) => Promise<void>;
  /** Decided before clone/model spend; block=true skips the review. Degrade is handled by buildEnv. */
  quotaGate?: (
    ctx: ReviewRevisionContext,
    opts: { runner: 'platform' | 'actions' },
  ) => Promise<{ block: boolean; reason?: string; reasonCode?: ReviewBlockReason }>;
  /** Neutral check-run explaining the block; its failure never lets the review run. */
  onBlocked?: (ctx: ReviewRevisionContext, reason: ReviewBlockReason) => Promise<void>;
  /** Immediate in_progress feedback after the gates, before clone/LLM spend; failure does not block. */
  acknowledge?: (ctx: ReviewRevisionContext) => Promise<void>;
  /** Moves the in_progress check to neutral on terminal failure only (not between retries). */
  onTerminalFailure?: (ctx: ReviewRevisionContext, error: unknown) => Promise<void>;
  /**
   * Called only when the stored config has auto disabled: gate-skips never refresh the stored
   * config, so enabling auto in `.winnowl.yaml` would otherwise never take effect. Returns the
   * repo file's `reviews.auto` fragment (fetched without a clone), or null.
   */
  recheckAutoFromRepoFile?: (ctx: ReviewRevisionContext) => Promise<Record<string, unknown> | null>;
  /** Changed paths for `max_changed_files`, fetched without a clone; failure/omission never blocks. */
  listChangedPaths?: (ctx: ReviewRevisionContext) => Promise<string[] | null>;
  /** Posts a status comment with a "review now" checkbox for skips a human can override. */
  onAutoReviewSkipped?: (ctx: ReviewRevisionContext, skip: AutoReviewSkip) => Promise<void>;
}

/** Superseded heads are skipped here; the publish gate also rejects stale heads. */
export function createReviewRevisionHandler(deps: ReviewRevisionDeps): JobHandler {
  return async ({ job, db, sandbox, signal, log }) => {
    const payload = job.payload as unknown as ReviewRevisionPayload;

    if (payload.tenantId !== job.tenantId) {
      throw new JobExecutionError(
        'review payload tenant does not match the claimed job tenant',
        'configuration_invalid',
        false,
      );
    }

    if (job.cancellationRequested) {
      log('review superseded, skipping', {
        changeRequestId: payload.changeRequestId,
        headSha: payload.headSha,
      });
      return;
    }

    const cr = await db
      .selectFrom('change_requests')
      .selectAll()
      .where('id', '=', payload.changeRequestId)
      .where('tenant_id', '=', job.tenantId)
      .where('repository_id', '=', payload.repositoryId)
      .executeTakeFirst();
    if (!cr) {
      throw new JobExecutionError(
        `change request not found: ${payload.changeRequestId}`,
        'repository_invalid',
        false,
      );
    }
    const repo = await db
      .selectFrom('repositories')
      // namespace/name/installation_id are only for trace tags (and erasing traces on uninstall).
      .select(['provider_host_id', 'namespace', 'name', 'installation_id', 'default_branch'])
      .where('id', '=', payload.repositoryId)
      .where('tenant_id', '=', job.tenantId)
      .executeTakeFirst();
    if (!repo) {
      throw new JobExecutionError(
        `repository not found: ${payload.repositoryId}`,
        'repository_invalid',
        false,
      );
    }
    const revision = await db
      .selectFrom('revisions')
      .select('id')
      .where('id', '=', payload.revisionId)
      .where('tenant_id', '=', job.tenantId)
      .where('change_request_id', '=', payload.changeRequestId)
      .where('head_sha', '=', payload.headSha)
      .executeTakeFirst();
    if (!revision) {
      throw new JobExecutionError(
        `revision does not match review payload: ${payload.revisionId}`,
        'repository_invalid',
        false,
      );
    }

    const changeRequest: ChangeRequestRef = {
      id: cr.id,
      repositoryId: cr.repository_id,
      nativeId: cr.native_id,
      number: cr.number,
      kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
    };
    const ctx: ReviewRevisionContext = {
      payload,
      changeRequest,
      providerHostId: repo.provider_host_id,
      db,
    };

    // Gates use the config stored by the last review (defaults on first run).
    const effective = await loadEffectiveConfig(db, payload.tenantId, payload.repositoryId);
    let auto = effective.reviews.auto;
    if (!auto.enabled && deps.recheckAutoFromRepoFile) {
      const fragment = await deps.recheckAutoFromRepoFile(ctx).catch((err) => {
        log('repo config recheck failed', {
          changeRequestId: payload.changeRequestId,
          error: (err as Error)?.message,
        });
        return null;
      });
      if (fragment && typeof fragment === 'object') {
        auto = { ...auto, ...(fragment as Partial<typeof auto>) };
        if (auto.enabled)
          log('review gate: repo yaml 开启覆盖落库配置', {
            changeRequestId: payload.changeRequestId,
          });
      }
    }
    const isManual = payload.trigger === 'manual';
    // A continuation round was admitted with the round it continues: only the state gates apply again.
    const isContinuation = payload.continueRound !== undefined;
    const crLabels: string[] = Array.isArray(cr.labels) ? cr.labels : [];
    // A stacked PR is gated on the stack root's target branch, otherwise `base_branches` would block
    // the whole stack. The provider's native stack base wins; else walk the inferred parent chain.
    const effectiveBaseBranch =
      cr.stack_base_ref ?? (await resolveStackRootTargetBranch(db, cr.id, cr.target_branch));
    const announceSkip = (status: AutoReviewSkip) =>
      deps.onAutoReviewSkipped?.(ctx, status).catch((err) =>
        log('status comment failed', { changeRequestId: payload.changeRequestId, error: (err as Error)?.message }),
      );
    const skip = autoReviewSkip({
      state: cr.state,
      draft: cr.draft,
      author: cr.author,
      authorIsBot: cr.author_is_bot ?? (cr.author ? isBotActor({ login: cr.author }) : false),
      paused: cr.auto_review_paused,
      targetBranch: cr.target_branch,
      effectiveBaseBranch,
      defaultBranch: repo.default_branch,
      labels: crLabels,
      auto,
      isManual,
    });
    if (skip) {
      log('review skipped by config', { changeRequestId: payload.changeRequestId, reason: skip.log });
      if (skip.status) await announceSkip(skip.status);
      return;
    }
    // pause_after_reviewed_commits counts non-cancelled review_costs since the last manual trigger,
    // so gate-skips and superseded runs do not count.
    if (!isManual && !isContinuation && auto.pause_after_reviewed_commits > 0) {
      const reviewJobs = await db
        .selectFrom('jobs')
        .select(['status', 'payload', 'created_at'])
        .where('tenant_id', '=', payload.tenantId)
        .where('type', '=', 'review_revision')
        .execute();
      const forCr = reviewJobs
        .map((j) => ({ ...j, p: j.payload as unknown as ReviewRevisionPayload }))
        .filter((j) => j.p.changeRequestId === payload.changeRequestId);
      const lastManualAt = forCr
        .filter((j) => j.p.trigger === 'manual')
        .reduce<Date | null>(
          (max, j) => (max === null || j.created_at > max ? (j.created_at as Date) : max),
          null,
        );
      let completedQuery = db
        .selectFrom('review_costs')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', payload.tenantId)
        .where('change_request_id', '=', payload.changeRequestId)
        .where('cancelled', '=', false);
      if (lastManualAt) completedQuery = completedQuery.where('created_at', '>', lastManualAt);
      const completedAutoSince = Number((await completedQuery.executeTakeFirst())?.n ?? 0);
      if (completedAutoSince >= auto.pause_after_reviewed_commits) {
        log('review skipped by config', {
          changeRequestId: payload.changeRequestId,
          reason: `已自动 review ${completedAutoSince} 次 ≥ pause_after_reviewed_commits=${auto.pause_after_reviewed_commits},等待显式命令`,
        });
        await announceSkip({ code: 'pause-after', count: completedAutoSince });
        return;
      }
    }

    // Skip a revision that was already fully reviewed: the bot's own PR body update emits `edited`,
    // and dedupe only covers in-flight jobs, so this would otherwise loop. Cancelled runs are
    // billed into review_costs too but do not count as a review.
    if (!isManual) {
      const reviewed = isContinuation
        ? undefined
        : await db
            .selectFrom('review_costs')
            .select('id')
            .where('revision_id', '=', payload.revisionId)
            .where('cancelled', '=', false)
            .executeTakeFirst();
      if (reviewed) {
        log('review skipped: revision already reviewed', {
          changeRequestId: payload.changeRequestId,
          revisionId: payload.revisionId,
        });
        return;
      }
      // A manual review of the same revision is still in flight: it bypasses every auto gate and
      // reviews this head anyway. Its dedupe key differs (`:manual`), so marking the pull request
      // ready (or any same-head event) during that run would otherwise start a second full review.
      // Two auto jobs of one revision share a dedupe key and never coexist, so only manual is checked.
      const manualInFlight = await db
        .selectFrom('jobs')
        .select('id')
        .where('tenant_id', '=', payload.tenantId)
        .where('type', '=', 'review_revision')
        .where('status', 'in', ['queued', 'leased', 'running'])
        .where(sql<boolean>`payload->>'revisionId' = ${payload.revisionId}`)
        .where(sql<boolean>`payload->>'trigger' = 'manual'`)
        .executeTakeFirst();
      if (manualInFlight) {
        log('review skipped: a manual review of this revision is in flight', {
          changeRequestId: payload.changeRequestId,
          revisionId: payload.revisionId,
          jobId: manualInFlight.id,
        });
        return;
      }
    }

    if (!isManual && !isContinuation && auto.max_changed_files > 0 && deps.listChangedPaths) {
      const paths = await deps.listChangedPaths(ctx).catch(() => null);
      const n = paths === null ? null : countReviewablePaths(paths, effective.reviews);
      if (n !== null && n > auto.max_changed_files) {
        log('review skipped by config', {
          changeRequestId: payload.changeRequestId,
          reason: `变更文件数 ${n} > reviews.auto.max_changed_files=${auto.max_changed_files}(大变更成本闸;@bot review 可显式触发)`,
        });
        await announceSkip({ code: 'too-many-files', count: n, limit: auto.max_changed_files });
        return;
      }
    }

    const gate = await deps.quotaGate?.(ctx, { runner: effective.sandbox.runner });
    if (gate?.block) {
      log('review skipped by quota', {
        changeRequestId: payload.changeRequestId,
        reason: gate.reason,
      });
      await deps
        .onBlocked?.(ctx, gate.reasonCode ?? 'other')
        .catch((err) =>
          log('quota block 回执失败(不影响已挡下)', { error: (err as Error).message }),
        );
      return;
    }

    await deps.acknowledge?.(ctx).catch((err) =>
      log('review acknowledge failed', {
        changeRequestId: payload.changeRequestId,
        error: (err as Error)?.message,
      }),
    );

    // Progress starts after the gates so skips leave no "in progress" row; report errors are swallowed.
    const progress = createProgressReporter(db, {
      jobId: job.id,
      tenantId: payload.tenantId,
      repositoryId: payload.repositoryId,
      changeRequestId: payload.changeRequestId,
      revisionId: payload.revisionId,
      attempt: job.attemptCount,
    });
    progress.report({ stage: 'prepare' });

    // Cooperative cancellation: a newer head sets cancellation_requested, checked before each
    // billable step. A failed check is treated as not cancelled.
    let cancelSeen = false;
    let lastCancelCheckAt = 0;
    const isCancelled = async (force = false): Promise<boolean> => {
      if (signal.aborted) {
        cancelSeen = true;
        return true;
      }
      if (cancelSeen) return true;
      const now = Date.now();
      if (!force && now - lastCancelCheckAt < CANCEL_POLL_INTERVAL_MS) return false;
      lastCancelCheckAt = now;
      try {
        const row = await db
          .selectFrom('jobs')
          .select('cancellation_requested')
          .where('id', '=', job.id)
          .executeTakeFirst();
        cancelSeen = row?.cancellation_requested === true;
      } catch (err) {
        log('cancellation check failed(按未取消继续)', {
          jobId: job.id,
          error: (err as Error)?.message,
        });
      }
      return cancelSeen;
    };

    // Trace context for every LLM call; revisionId groups one review as a session. It must also wrap
    // buildEnv, which copies it into the sandbox executor spec.
    const reviewTrace = {
      tenantId: payload.tenantId,
      // Used to erase this installation's traces on uninstall.
      installationId: repo.installation_id,
      repo: `${repo.namespace}/${repo.name}`,
      changeRequestNumber: cr.number,
      sessionId: payload.revisionId,
      stage: 'review',
      tags: ['review', isManual ? 'manual' : 'auto'],
      ...(payload.initiatedByUserId ? { userId: payload.initiatedByUserId } : {}),
    };

    // Disposed by this job in finally, so concurrent reviews never delete each other's worktree.
    let disposeWorkspace: (() => Promise<void>) | undefined;
    try {
      const startedAt = Date.now();
      const env = await withLlmTraceContext(reviewTrace, () => deps.buildEnv(ctx));
      const prepareMs = Date.now() - startedAt;
      disposeWorkspace = env.disposeWorkspace;
      const orchestratorDeps: ReviewOrchestratorDeps = {
        ...env,
        isCancelled,
        onProgress: progress.report,
        newId: deps.newId ?? ((): string => uuidv7()),
        publishTarget: {
          tenantId: payload.tenantId,
          repositoryId: payload.repositoryId,
          changeRequest,
          changeRequestId: payload.changeRequestId,
          revisionId: payload.revisionId,
          revisionSha: payload.headSha,
          providerHostId: repo.provider_host_id,
          expectedHeadSha: payload.headSha,
          // Manual reviews scope idempotency to the job id: a re-request posts anew, retries do not.
          ...(isManual ? { idempotencyScope: job.id } : {}),
        },
      };

      if (env.guidanceReport && env.guidanceReport.rejected.length > 0) {
        log('repository guidance dropped', {
          changeRequestId: payload.changeRequestId,
          rejected: env.guidanceReport.rejected,
        });
      }
      // In the sandbox path only exploration + verification run there; publishing stays here.
      const runReview = async (): Promise<ReviewOutcome> => {
        let outcome: ReviewOutcome;
        if (env.runner === 'actions') {
          // GitHub gives fork pull requests no OIDC token, so the action could not prove which run is its own.
          if (cr.source_is_fork) throw new RunnerSetupError('actions-fork');
          if (!env.executorSpec) throw new Error('the GitHub Actions runner needs a configured model (no executor spec)');
          // The user's own key pays for these calls.
          ctx.modelSourceKind = 'byok';
          const { produced, pluginCalls } = await runReviewInActions(env.executorSpec, {
            db: ctx.db,
            tenantId: payload.tenantId,
            jobId: job.id,
            repositoryId: payload.repositoryId,
            changeRequestNumber: cr.number,
            headSha: payload.headSha,
            image: actionsExecutorImage(process.env),
            log,
            onProgress: progress.report,
            isCancelled,
            signal,
          });
          for (const call of pluginCalls) await env.onPluginCall?.(call);
          outcome = await publishReview(produced, orchestratorDeps);
        } else if (
          process.env.REVIEW_IN_SANDBOX === '1' &&
          env.executorSpec &&
          canRunReviewInSandbox(sandbox, env.codePlane)
        ) {
          log('review running in sandbox', {
            changeRequestId: payload.changeRequestId,
            skills: env.executorSpec.skills?.length ?? 0,
            guidance: env.guidanceReport?.files ?? [],
          });
          const { produced, pluginCalls } = await runReviewInSandbox(
            env.executorSpec,
            env.codePlane,
            {
              sandbox,
              image: process.env.REVIEW_SANDBOX_IMAGE ?? 'winnowl:latest',
              resources: reviewSandboxResources(),
              log,
              onProgress: progress.report,
              isCancelled,
              ...(deps.llmRelay ? { relay: deps.llmRelay } : {}),
              ...(deps.requireLlmRelay ? { requireRelay: true } : {}),
            },
          );
          // Sandbox plugin calls are only recorded in memory; audit + metering happen here.
          for (const call of pluginCalls) await env.onPluginCall?.(call);
          outcome = await publishReview(produced, orchestratorDeps);
        } else {
          outcome = await runReviewAndPublish(orchestratorDeps);
        }
        return outcome;
      };

      const reviewed = await withLlmTraceContext(reviewTrace, runReview);
      const outcome: ReviewOutcome = {
        ...reviewed,
        stageMs: { prepare: prepareMs, ...reviewed.stageMs, total: Date.now() - startedAt },
      };

      // Cancelled: no publication, but usage is still billed. The orchestrator is the publication
      // boundary: a cancellation arriving after a non-cancelled outcome must not skip onOutcome.
      if (outcome.cancelled) {
        await progress.finish('cancelled');
        await deps.onCancelled?.(outcome, ctx);
        // Supersede returns normally (recorded as superseded); an abort (shutdown / lease loss)
        // must throw, or the unfinished run would be recorded as completed.
        throwIfInterrupted(signal);
        log('review cancelled(被新 Head 取代,提前收工;已发生用量照常计费)', {
          changeRequestId: payload.changeRequestId,
          headSha: payload.headSha,
          candidateCount: outcome.candidateCount,
          coverage: outcome.coverage,
          ...(outcome.usage ? { costUsd: outcome.usage.costUsd } : {}),
        });
        return;
      }

      await progress.finish('done');
      await deps.onOutcome?.(outcome, ctx);
      log('review completed', {
        changeRequestId: payload.changeRequestId,
        candidateCount: outcome.candidateCount,
        publishedInline: outcome.publishedInline,
        // >0 means the result is incomplete: remaining candidates were not verified.
        ...(outcome.costCappedCandidates
          ? { costCappedCandidates: outcome.costCappedCandidates }
          : {}),
        ...(outcome.costCappedScopes ? { costCappedScopes: outcome.costCappedScopes } : {}),
        ...(outcome.deadlineCappedCandidates
          ? { deadlineCappedCandidates: outcome.deadlineCappedCandidates }
          : {}),
        // `unplanned` = changed files the map stage missed.
        ...(outcome.coveredPaths?.length ? { coveredPaths: outcome.coveredPaths.length } : {}),
        ...(outcome.unreachedPaths?.length
          ? { unreachedPaths: outcome.unreachedPaths.length }
          : {}),
        ...(outcome.unplannedPaths?.length
          ? { unplannedPaths: outcome.unplannedPaths.length }
          : {}),
        ...(outcome.incompleteScopes ? { incompleteScopes: outcome.incompleteScopes } : {}),
        ...(outcome.suggestions ? { suggestions: outcome.suggestions } : {}),
        ...(outcome.externalFactsSubmitted
          ? { externalFacts: { submitted: outcome.externalFactsSubmitted, kept: outcome.externalFacts?.length ?? 0 } }
          : {}),
        // How each unresolved prior blocking finding was judged; not stored anywhere else.
        ...(outcome.unresolvedPriorBlocking?.length
          ? {
              unresolvedPrior: outcome.unresolvedPriorBlocking.map((r) => ({
                method: r.method,
                ...(r.path ? { path: r.path } : {}),
              })),
            }
          : {}),
        ...(outcome.resolvedFindingIds?.length
          ? { resolvedPriorCount: outcome.resolvedFindingIds.length }
          : {}),
        // Stale archiving is the only path that retires a finding silently, so it is logged.
        ...(outcome.staleFindingIds?.length
          ? { staleArchived: outcome.staleFindingIds.length }
          : {}),
        ...(outcome.priorReconcile ? { priorReconcile: outcome.priorReconcile } : {}),
        // >0: prior findings left out of cross-round matching; they will reappear as new findings.
        ...(outcome.priorMatchTruncated
          ? { priorMatchTruncated: outcome.priorMatchTruncated }
          : {}),
        // >0: duplicate rows for one defect already accumulated in the gate list (merged for display).
        ...(outcome.unresolvedDuplicatesMerged
          ? { unresolvedDuplicatesMerged: outcome.unresolvedDuplicatesMerged }
          : {}),
        ...(outcome.stageMs ? { msByStage: outcome.stageMs } : {}),
        // >0: early tool output was elided because an invocation neared the context window.
        ...(outcome.elidedToolResults ? { elidedToolResults: outcome.elidedToolResults } : {}),
        ...(outcome.stageUsage
          ? {
              costByStage: Object.fromEntries(
                Object.entries(outcome.stageUsage).map(([stage, u]) => [
                  stage,
                  Number(u.costUsd.toFixed(4)),
                ]),
              ),
              // `cacheRead` shows whether the shared prefix (dig_context=fork-map) is actually cached.
              tokensByStage: Object.fromEntries(
                Object.entries(outcome.stageUsage).map(([stage, u]) => [
                  stage,
                  {
                    turns: u.turns,
                    in: u.inputTokens,
                    out: u.outputTokens,
                    ...(u.cacheReadTokens > 0 ? { cacheRead: u.cacheReadTokens } : {}),
                    ...(u.reasoningTokens > 0 ? { reasoning: u.reasoningTokens } : {}),
                  },
                ]),
              ),
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof ActionsRunCancelledError) {
        await progress.finish('cancelled');
        log('review cancelled before GitHub Actions claimed it', { changeRequestId: payload.changeRequestId, headSha: payload.headSha });
        return;
      }
      await progress.finish('failed');
      // Terminal = last attempt or non-retryable (same decision as failJob). Not terminal once the
      // signal is aborted: the job goes back to the queue.
      const { failureClass, retryable } = classifyJobError(error);
      const nonRetryable = !signal.aborted && !(retryable ?? isRetryableFailure(failureClass));
      if (nonRetryable || job.attemptCount >= job.maxAttempts) {
        await deps.onTerminalFailure?.(ctx, error).catch((err) =>
          log('review terminal-failure ack failed', {
            changeRequestId: payload.changeRequestId,
            error: (err as Error)?.message,
          }),
        );
      }
      throw error;
    } finally {
      await disposeWorkspace?.().catch((err) =>
        log('review workspace cleanup failed', {
          changeRequestId: payload.changeRequestId,
          error: (err as Error)?.message,
        }),
      );
    }
  };
}
