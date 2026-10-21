import { sql, type Db } from '@reviewbot/db';

/**
 * Progress of in-flight reviews, for the console. Every write swallows its own errors: a failed UI
 * update must not break a running review.
 */

export interface ProgressKey {
  jobId: string;
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
  revisionId: string;
  attempt: number;
}

/** `done/total` omitted: the stage has no countable units. */
export interface ProgressUpdate {
  stage: string;
  done?: number;
  total?: number;
}

/**
 * Whether a write may land. A finished row can only be reopened by a new attempt; late writes from
 * the same attempt are dropped.
 */
const ACCEPTS_PROGRESS = sql<boolean>`review_progress.finished_at is null
      or review_progress.attempt <> excluded.attempt`;

/**
 * Upserts progress for the job (retries share one row) and clears `finished_at` on a new attempt.
 * A finished row must not be revived by a late write of the same attempt: `report` is fire-and-forget,
 * so its INSERT can race `finishProgress` and would leave the row "in progress" forever.
 */
export async function writeProgress(db: Db, key: ProgressKey, p: ProgressUpdate): Promise<void> {
  const now = new Date();
  await db
    .insertInto('review_progress')
    .values({
      job_id: key.jobId,
      tenant_id: key.tenantId,
      repository_id: key.repositoryId,
      change_request_id: key.changeRequestId,
      revision_id: key.revisionId,
      stage: p.stage,
      done: p.done ?? null,
      total: p.total ?? null,
      attempt: key.attempt,
      started_at: now,
      updated_at: now,
      finished_at: null,
    })
    .onConflict((oc) =>
      oc.column('job_id').doUpdateSet({
        stage: p.stage,
        done: p.done ?? null,
        total: p.total ?? null,
        attempt: key.attempt,
        // Elapsed time is per attempt, matching the attempt counter and progress bar shown next to it.
        started_at: sql`case when review_progress.attempt <> excluded.attempt then now() else review_progress.started_at end`,
        updated_at: now,
        // A retry moves the row back to in progress.
        finished_at: null,
      })
      .where(ACCEPTS_PROGRESS),
    )
    .execute();
}

/**
 * Marks the row finished with `done` / `failed` / `cancelled`. The row is kept so recent results stay
 * visible; the retention sweep removes it by `finished_at`.
 */
export async function finishProgress(db: Db, jobId: string, stage: 'done' | 'failed' | 'cancelled'): Promise<void> {
  const now = new Date();
  await db
    .updateTable('review_progress')
    .set({ stage, updated_at: now, finished_at: now })
    .where('job_id', '=', jobId)
    .execute();
}

/**
 * Closes rows still in progress whose job is terminal (the process was killed or the finish write
 * failed); returns how many. The outcome is inferred from the job status, and `finished_at` is the job's
 * completion time so old rows do not reappear in the console's recently-finished window.
 */
export async function sweepStaleProgress(db: Db): Promise<number> {
  const result = await sql<{ job_id: string }>`
    update review_progress p
       set stage = case
                     when j.status = 'failed' then 'failed'
                     when j.status in ('cancelled', 'superseded') or j.cancellation_requested
                       then 'cancelled'
                     else 'done'
                   end,
           finished_at = coalesce(j.completed_at, now()),
           updated_at = now()
      from jobs j
     where j.id = p.job_id
       and p.finished_at is null
       and j.status in ('completed', 'failed', 'superseded', 'cancelled')
    returning p.job_id
  `.execute(db);
  return result.rows.length;
}

/**
 * Unfinished rows idle for this long are dropped by the retention sweep even though they never
 * got a `finished_at`. `sweepStaleProgress` closes rows whose job reached a terminal status, so
 * what is left here belongs to a job that is still non-terminal (e.g. requeued after a lease
 * expiry and never claimed again). A live attempt refreshes `updated_at` on every stage
 * (one review is capped at 95 minutes), so 90 idle days can only be an abandoned row. It is
 * deliberately longer than the finished-row window: the stuck "in progress" row is the visible
 * signal of a stuck job and should outlive normal history long enough to be investigated.
 * Deleting a row that turns out to be alive is harmless: the next `writeProgress` upserts it back.
 */
export const ABANDONED_PROGRESS_DAYS = 90;

const DAY_MS = 86_400_000;

/**
 * Retention for one tenant's `review_progress`: finished rows older than `finishedDays` by `finished_at`,
 * unfinished rows older than `ABANDONED_PROGRESS_DAYS` by `updated_at`.
 */
export async function purgeExpiredProgress(
  db: Db,
  opts: { tenantId: string; finishedDays: number; now?: Date },
): Promise<{ finished: number; abandoned: number }> {
  const now = (opts.now ?? new Date()).getTime();
  const finishedCutoff = new Date(now - opts.finishedDays * DAY_MS);
  const abandonedCutoff = new Date(now - ABANDONED_PROGRESS_DAYS * DAY_MS);
  const finished = await db
    .deleteFrom('review_progress')
    .where('tenant_id', '=', opts.tenantId)
    .where('finished_at', 'is not', null)
    .where('finished_at', '<', finishedCutoff)
    .executeTakeFirst();
  const abandoned = await db
    .deleteFrom('review_progress')
    .where('tenant_id', '=', opts.tenantId)
    .where('finished_at', 'is', null)
    .where('updated_at', '<', abandonedCutoff)
    .executeTakeFirst();
  return { finished: Number(finished.numDeletedRows), abandoned: Number(abandoned.numDeletedRows) };
}

/** The above as fire-and-forget calls that ignore failures, for use on hot paths. */
export function createProgressReporter(db: Db, key: ProgressKey): {
  report: (p: ProgressUpdate) => void;
  finish: (stage: 'done' | 'failed' | 'cancelled') => Promise<void>;
} {
  return {
    report: (p) => {
      void writeProgress(db, key, p).catch(() => undefined);
    },
    finish: async (stage) => {
      await finishProgress(db, key.jobId, stage).catch(() => undefined);
    },
  };
}
