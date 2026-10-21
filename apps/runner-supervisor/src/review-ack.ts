import type { Db } from '@reviewbot/db';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import type { ReviewRevisionContext, ReviewBlockReason } from './review-revision.js';
import { botMessages } from './locale.js';
import { loadRepositoryRef } from './repository-ref.js';

/**
 * Immediate review acknowledgement on the PR, before any LLM work:
 * - `acknowledge`: check-run `winnowl/review` in_progress + 👀 on the PR body.
 * - `onTerminalFailure` / `onReviewJobTimedOut`: the same check-run goes neutral (never blocks merge).
 * Check-run name and idempotency key match review-checks.ts, so GitHub upserts one run through all states.
 */
export interface ReviewAckDeps {
  db: Db;
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
}

const CHECK_NAME = 'winnowl/review';
function checkKey(changeRequestId: string, headSha: string): string {
  return `check:${changeRequestId}:${headSha}`;
}

export function createReviewAcknowledger(deps: ReviewAckDeps): {
  acknowledge: (ctx: ReviewRevisionContext) => Promise<void>;
  onBlocked: (ctx: ReviewRevisionContext, reason: ReviewBlockReason) => Promise<void>;
  onTerminalFailure: (ctx: ReviewRevisionContext, error: unknown) => Promise<void>;
  onReviewJobTimedOut: (payload: { tenantId: string; repositoryId: string; changeRequestId: string; headSha: string }) => Promise<void>;
} {
  async function language(tenantId: string | undefined, repositoryId: string | undefined): Promise<string | undefined> {
    if (!tenantId || !repositoryId) return undefined;
    return (await loadEffectiveConfig(deps.db, tenantId, repositoryId)).language;
  }

  return {
    acknowledge: async (ctx) => {
      const provider = await deps.buildProvider(ctx.payload.repositoryId);
      const repo = await loadRepositoryRef(ctx.db, ctx.payload.repositoryId);
      const m = botMessages(await language(ctx.payload.tenantId, ctx.payload.repositoryId)).checks;
      await provider.checks.createOrUpdate(
        repo,
        { name: CHECK_NAME, status: 'in-progress', title: m.inProgress(), summary: m.inProgressSummary(), headSha: ctx.payload.headSha },
        { key: checkKey(ctx.payload.changeRequestId, ctx.payload.headSha) },
      );
      // Reaction only where the Provider supports it; failure does not affect the check.
      await provider.reactions?.addToChangeRequest(ctx.changeRequest, 'eyes').catch(() => undefined);
    },

    /**
     * Blocked by quota/circuit breaker → neutral check-run (never blocks merge) stating cause and recovery.
     * This may be the first check-run for the headSha; upsert keeps later in_progress retries consistent.
     */
    onBlocked: async (ctx, reason) => {
      const provider = await deps.buildProvider(ctx.payload.repositoryId);
      const repo = await loadRepositoryRef(ctx.db, ctx.payload.repositoryId);
      const m = botMessages(await language(ctx.payload.tenantId, ctx.payload.repositoryId)).checks;
      const text =
        reason === 'daily_cost_cap'
          ? { title: m.costCapTripped(), summary: m.costCapTrippedSummary() }
          : reason === 'cost_quota'
            ? { title: m.monthlyCostCapExhausted(), summary: m.monthlyCostCapExhaustedSummary() }
            : reason === 'token_quota'
              ? { title: m.tokenQuotaExhausted(), summary: m.tokenQuotaExhaustedSummary() }
              : { title: m.quotaExhausted(), summary: m.quotaExhaustedSummary() };
      await provider.checks.createOrUpdate(
        repo,
        { name: CHECK_NAME, status: 'completed', conclusion: 'neutral', title: text.title, summary: text.summary, headSha: ctx.payload.headSha },
        { key: checkKey(ctx.payload.changeRequestId, ctx.payload.headSha) },
      );
    },

    onTerminalFailure: async (ctx, _error) => {
      const provider = await deps.buildProvider(ctx.payload.repositoryId);
      const repo = await loadRepositoryRef(ctx.db, ctx.payload.repositoryId);
      const m = botMessages(await language(ctx.payload.tenantId, ctx.payload.repositoryId)).checks;
      // neutral, not failure: never blocks merge.
      await provider.checks.createOrUpdate(
        repo,
        { name: CHECK_NAME, status: 'completed', conclusion: 'neutral', title: m.failed(), summary: m.failedSummary(), headSha: ctx.payload.headSha },
        { key: checkKey(ctx.payload.changeRequestId, ctx.payload.headSha) },
      );
    },

    onReviewJobTimedOut: async (payload) => {
      const provider = await deps.buildProvider(payload.repositoryId);
      const repo = await loadRepositoryRef(deps.db, payload.repositoryId);
      const m = botMessages(await language(payload.tenantId, payload.repositoryId)).checks;
      await provider.checks.createOrUpdate(
        repo,
        { name: CHECK_NAME, status: 'completed', conclusion: 'neutral', title: m.timedOut(), summary: m.timedOutSummary(), headSha: payload.headSha },
        { key: checkKey(payload.changeRequestId, payload.headSha) },
      );
    },
  };
}

/**
 * Conversation ack: 👀 on the issue or CR an @mention came from. Review threads are skipped (the inline
 * reply is the ack). Best effort: silently skipped when unsupported or incomplete.
 */
export function createConversationAcknowledger(deps: ReviewAckDeps): (payload: {
  target: { kind: string; nativeId: string };
  repositoryId?: string;
  changeRequestId?: string;
  issueNumber?: number;
}) => Promise<void> {
  return async (payload) => {
    if (!payload.repositoryId) return;
    const provider = await deps.buildProvider(payload.repositoryId);
    if (!provider.reactions) return;
    if (payload.target.kind === 'issue' && payload.issueNumber !== undefined) {
      await provider.reactions.addToIssue(
        { id: '', repositoryId: payload.repositoryId, nativeId: payload.target.nativeId, number: payload.issueNumber },
        'eyes',
      );
      return;
    }
    if (payload.target.kind === 'change-request' && payload.changeRequestId) {
      const cr = await deps.db
        .selectFrom('change_requests')
        .select(['id', 'repository_id', 'native_id', 'number', 'kind'])
        .where('id', '=', payload.changeRequestId)
        .executeTakeFirst();
      if (!cr) return;
      await provider.reactions.addToChangeRequest(
        {
          id: cr.id,
          repositoryId: cr.repository_id,
          nativeId: cr.native_id,
          number: cr.number,
          kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
        },
        'eyes',
      );
    }
  };
}

/** Review ack fields from a SweptJob payload; null when missing (not a review or malformed). */
export function reviewPayloadFromSwept(type: string, payload: Record<string, unknown>): {
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
  headSha: string;
} | null {
  if (type !== 'review_revision') return null;
  const tenantId = payload.tenantId;
  const repositoryId = payload.repositoryId;
  const changeRequestId = payload.changeRequestId;
  const headSha = payload.headSha;
  if (typeof tenantId !== 'string' || typeof repositoryId !== 'string' || typeof changeRequestId !== 'string' || typeof headSha !== 'string') {
    return null;
  }
  return { tenantId, repositoryId, changeRequestId, headSha };
}
