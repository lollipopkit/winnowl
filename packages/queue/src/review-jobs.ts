import type { Db } from '@reviewbot/db';
import { sql } from 'kysely';
import { enqueueJob } from './queue.js';

/**
 * Model gateway outages last minutes; with `retryable_model` backoff, 4 attempts cover ~250s versus ~90s for 3.
 * More attempts each redo clone and dependency scan and delay surfacing real failures.
 */
export const REVIEW_JOB_MAX_ATTEMPTS = 4;

export function reviewDedupeKey(input: {
  repositoryId: string;
  changeRequestId: string;
  headSha: string;
  configDigest: string;
}): string {
  return `review:${input.repositoryId}:${input.changeRequestId}:${input.headSha}:${input.configDigest}`;
}

/**
 * Supersedes review jobs for older heads of the same CR: queued ones become superseded,
 * leased/running ones get cancellation_requested (the publish gate rejects stale heads).
 */
export async function supersedeOlderReviewJobs(
  db: Db,
  input: { tenantId: string; changeRequestId: string; headSha: string },
): Promise<number> {
  const res = await sql<{ id: string }>`
    update jobs
    set cancellation_requested = true,
        status = case when status = 'queued' then 'superseded' else status end
    where type = 'review_revision'
      and tenant_id = ${input.tenantId}::uuid
      and status in ('queued', 'leased', 'running')
      and payload->>'changeRequestId' = ${input.changeRequestId}
      and payload->>'headSha' <> ${input.headSha}
    returning id
  `.execute(db);
  return res.rows.length;
}

/**
 * Cooperative cancel: the orchestrator stops at the next spend boundary without publishing, so usage is still recorded.
 * The tenant predicate is explicit because RLS is permissive without a tenant context.
 * Returns false if the job is finished, not a review, or another tenant's.
 */
export async function cancelReviewJob(db: Db, tenantId: string, jobId: string): Promise<boolean> {
  const res = await sql<{ id: string }>`
    update jobs
    set cancellation_requested = true,
        status = case when status = 'queued' then 'superseded' else status end
    where id = ${jobId}::uuid
      and tenant_id = ${tenantId}::uuid
      and type = 'review_revision'
      and status in ('queued', 'leased', 'running')
    returning id
  `.execute(db);
  return res.rows.length > 0;
}

/** On CR close/merge, cooperatively cancels all its in-flight review jobs regardless of head. */
export async function cancelReviewJobsForChangeRequest(
  db: Db,
  tenantId: string,
  changeRequestId: string,
): Promise<number> {
  const res = await sql<{ id: string }>`
    update jobs
    set cancellation_requested = true,
        status = case when status = 'queued' then 'superseded' else status end
    where type = 'review_revision'
      and tenant_id = ${tenantId}::uuid
      and status in ('queued', 'leased', 'running')
      and payload->>'changeRequestId' = ${changeRequestId}
    returning id
  `.execute(db);
  return res.rows.length;
}

/**
 * A review requested by a person (comment, checkbox, re-run of the Actions workflow) for the latest head:
 * older heads are superseded; one job per head and kind (`full` re-reviews the whole pull request).
 */
export async function enqueueManualReview(
  db: Db,
  input: {
    tenantId: string;
    repositoryId: string;
    changeRequestId: string;
    revisionId: string;
    headSha: string;
    full?: boolean;
    initiatedByUserId?: string;
  },
): Promise<void> {
  await supersedeOlderReviewJobs(db, input);
  await enqueueJob(db, {
    tenantId: input.tenantId,
    type: 'review_revision',
    payload: {
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      changeRequestId: input.changeRequestId,
      revisionId: input.revisionId,
      headSha: input.headSha,
      configDigest: '',
      trigger: 'manual',
      ...(input.full ? { forceFullReview: true } : {}),
      ...(input.initiatedByUserId ? { initiatedByUserId: input.initiatedByUserId } : {}),
    },
    dedupeKey:
      reviewDedupeKey({
        repositoryId: input.repositoryId,
        changeRequestId: input.changeRequestId,
        headSha: input.headSha,
        configDigest: '',
      }) + (input.full ? ':manual:full' : ':manual'),
    maxAttempts: REVIEW_JOB_MAX_ATTEMPTS,
  });
}
