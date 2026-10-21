import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { resolveFindingThread } from '@reviewbot/publisher';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import { BADGE } from './badges.js';
import type { ReviewRevisionContext } from './review-revision.js';
import { botMessages } from './locale.js';

export interface ReviewThreadResolverDeps {
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
}

/** Marker of an appended "fixed" note; its presence keeps job retries and recurring findings idempotent. */
const RESOLVED_MARKER = '<!-- winnowl:resolved -->';

/**
 * For preexisting findings the gate confirmed fixed: appends the fixing commit to their inline comments
 * on this CR and resolves the threads.
 * - Threads come from `publication_records` (bot comments only) via listThreads: GitLab thread ids are
 *   discussion ids, not comment ids.
 * - The note is an edit, not a reply: edits are idempotent via the marker, GitHub replies are not.
 * - `stale` is excluded: it is an inference and must not be announced as fixed.
 */
export function createReviewThreadResolver(
  deps: ReviewThreadResolverDeps,
): (outcome: ReviewOutcome, ctx: ReviewRevisionContext) => Promise<void> {
  return async (outcome, ctx) => {
    const findingIds = outcome.resolvedFindingIds ?? [];
    if (findingIds.length === 0) return;

    // writeFindings replaces candidate ids with real finding_ids, so this must run after it.
    const rows = await ctx.db
      .selectFrom('publication_records')
      .select('provider_native_id')
      .where('change_request_id', '=', ctx.payload.changeRequestId)
      .where('kind', '=', 'inline')
      .where('state', '=', 'published')
      .where('finding_id', 'in', findingIds)
      .where('provider_native_id', 'is not', null)
      .execute();
    // A finding may have an inline comment per round (reposted after anchors moved); close each.
    const commentIds = new Set(rows.map((r) => r.provider_native_id as string));
    if (commentIds.size === 0) return;

    const provider = await deps.buildProvider(ctx.payload.repositoryId);
    const caps = await provider.capabilities.forChangeRequest(ctx.changeRequest);
    const cfg = await loadEffectiveConfig(ctx.db, ctx.payload.tenantId, ctx.payload.repositoryId);
    const note = `${BADGE.resolved} ${botMessages(cfg.language).resolution.addressed({ sha: ctx.payload.headSha.slice(0, 7) })}`;

    const threads = await provider.discussions.listThreads({ kind: 'change-request', ref: ctx.changeRequest });
    for (const thread of threads) {
      const comment = thread.comments.find((c) => c.isBot && commentIds.has(c.nativeId));
      if (!comment || thread.resolved) continue;
      if (!comment.body.includes(RESOLVED_MARKER)) {
        await provider.discussions.editComment(
          { nativeId: comment.nativeId, changeRequest: ctx.changeRequest, scope: 'review' },
          { markdown: `${comment.body}\n\n---\n${note}\n${RESOLVED_MARKER}` },
        );
      }
      await resolveFindingThread(provider.discussions, thread.ref, {
        resolvableThreads: caps.resolvableThreads,
        isBotThread: true,
      });
    }
  };
}
