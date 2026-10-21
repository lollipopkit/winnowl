import { sql, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';
import { recordReviewCost } from '@reviewbot/telemetry';
import type { ReviewRevisionContext } from './review-revision.js';

/**
 * Sums platform plugin-call costs for a revision from `plugin.call` audits (BYOK/keyless count 0).
 * A revision reviewed several times has a row per review, so only calls after the previous row count.
 */
async function pluginCostForRun(db: Db, tenantId: string, revisionId: string): Promise<number> {
  const previous = await db
    .selectFrom('review_costs')
    .select('created_at')
    .where('revision_id', '=', revisionId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  let query = db
    .selectFrom('audit_events')
    .select(sql<string>`coalesce(sum((detail->>'costUsd')::numeric), 0)`.as('total'))
    .where('tenant_id', '=', tenantId)
    .where('action', '=', 'plugin.call')
    .where(sql<boolean>`detail->>'revisionId' = ${revisionId}`);
  if (previous) query = query.where('created_at', '>', previous.created_at as Date);
  const row = await query.executeTakeFirst();
  return Number(row?.total ?? 0);
}

/**
 * Writes one `review_costs` row per review (exploration + verification tokens/cost + plugin costs);
 * overwriting would erase earlier reviews from billing. Nothing is written without provider usage.
 */
export function createReviewCostWriter(): (outcome: ReviewOutcome, ctx: ReviewRevisionContext) => Promise<void> {
  return async (outcome, ctx) => {
    const u = outcome.usage;
    if (!u) return; // e.g. faux model: avoid all-zero rows
    const pluginCost = await pluginCostForRun(ctx.db, ctx.payload.tenantId, ctx.payload.revisionId);
    /*
     * Pin the repository's visibility at this moment: repos change visibility, and recomputing history from
     * the current state would rewrite already-billed usage (same reason as `model_source`).
     */
    const repo = await ctx.db
      .selectFrom('repositories')
      .select('visibility')
      .where('id', '=', ctx.payload.repositoryId)
      .executeTakeFirst();
    const repoVisibility = repo?.visibility ?? null;
    const costUsd = u.costUsd + pluginCost;
    const now = new Date();
    // Cost/token metrics split by model_source (platform|byok).
    recordReviewCost(ctx.modelSourceKind ?? 'platform', costUsd, u.inputTokens, u.outputTokens);
    await ctx.db
      .insertInto('review_costs')
      .values({
        id: uuidv7(),
        tenant_id: ctx.payload.tenantId,
        repository_id: ctx.payload.repositoryId,
        change_request_id: ctx.payload.changeRequestId,
        revision_id: ctx.payload.revisionId,
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        total_tokens: u.totalTokens,
        cost_usd: costUsd,
        candidate_count: outcome.candidateCount,
        published_inline: outcome.publishedInline,
        scopes_total: outcome.coverage.scopesTotal,
        scopes_complete: outcome.coverage.scopesComplete,
        // BYOK marker set by buildEnv: the tenant pays model cost.
        model_source: ctx.modelSourceKind ?? 'platform',
        repo_visibility: repoVisibility,
        // Per-stage usage (map/dig/synthesis/verify).
        stage_usage: (outcome.stageUsage ?? null) as Record<string, unknown> | null,
        stage_ms: outcome.stageMs ?? null,
        // A cancelled review is billed but does not count as reviewed: the self-trigger loop guard reads this
        // table, and counting it would stop the revision from ever being auto-reviewed again.
        cancelled: outcome.cancelled === true,
        created_at: now,
      })
      .execute();
  };
}
