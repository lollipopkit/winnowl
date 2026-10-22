import { platformSetting } from '@reviewbot/config';
import type { Db } from '@reviewbot/db';
import { enqueueJob, REVIEW_JOB_MAX_ATTEMPTS, reviewDedupeKey } from '@reviewbot/queue';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';
import type { ReviewRevisionPayload } from './review-revision.js';

/**
 * Whether a finished round should start the next one on its own: files of this head are still
 * unreviewed, this round covered at least one new file (no progress = the rest would only repeat),
 * and the chain is within `review.auto_continue_rounds`.
 */
export function shouldContinueReview(
  outcome: Pick<ReviewOutcome, 'coveredPaths' | 'deferredPaths' | 'unreachedPaths' | 'unplannedPaths'>,
  payload: Pick<ReviewRevisionPayload, 'continueRound'>,
  maxRounds: number,
): boolean {
  const remaining =
    (outcome.deferredPaths?.length ?? 0) + (outcome.unreachedPaths?.length ?? 0) + (outcome.unplannedPaths?.length ?? 0);
  return remaining > 0 && (outcome.coveredPaths?.length ?? 0) > 0 && (payload.continueRound ?? 0) < maxRounds;
}

/** Enqueues the next round for the same head; returns false when it is not due or the head has moved on. */
export async function continueReview(db: Db, payload: ReviewRevisionPayload, outcome: ReviewOutcome): Promise<boolean> {
  const maxRounds = Number(await platformSetting(db, 'review.auto_continue_rounds'));
  if (!(maxRounds > 0) || !shouldContinueReview(outcome, payload, maxRounds)) return false;
  const latest = await db
    .selectFrom('revisions')
    .select('head_sha')
    .where('change_request_id', '=', payload.changeRequestId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (latest?.head_sha !== payload.headSha) return false;
  const round = (payload.continueRound ?? 0) + 1;
  // Keeps the trigger and initiator, so a manual review stays manual; a full review is not redone, the
  // ledger it wrote is what the next round continues from.
  const { forceFullReview: _full, ...rest } = payload;
  await enqueueJob(db, {
    tenantId: payload.tenantId,
    type: 'review_revision',
    payload: { ...rest, continueRound: round },
    dedupeKey: `${reviewDedupeKey(payload)}:continue:${round}`,
    maxAttempts: REVIEW_JOB_MAX_ATTEMPTS,
  });
  return true;
}
