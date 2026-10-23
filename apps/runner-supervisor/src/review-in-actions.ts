import { setTimeout as sleep } from 'node:timers/promises';
import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import {
  unkeyedExecutorSpec,
  type ExecutorErrorReport,
  type ReviewExecutorOutput,
  type ReviewExecutorSpec,
} from '@reviewbot/review-runtime';
import { ACTIONS_CLAIM_TIMEOUT_MINUTES, errorFromExecutorReport, RunnerSetupError } from './executor-error.js';
import { execTimeoutMs } from './review-in-sandbox.js';

/**
 * Control-plane side of a review whose executor runs in the repository's GitHub Actions: parks a keyless
 * spec in `actions_runs`, waits for the action to claim it (control-api, OIDC), relays progress and
 * cancellation, and returns the output. Every failure is final: the workflow does not run again on retry.
 */

export interface RunInActionsDeps {
  db: Db;
  tenantId: string;
  jobId: string;
  repositoryId: string;
  changeRequestNumber: number;
  headSha: string;
  image: string;
  log: (message: string, data?: Record<string, unknown>) => void;
  onProgress?: (p: { stage: string; done?: number; total?: number }) => void;
  isCancelled?: () => boolean | Promise<boolean>;
  /** The job lost its lease or the runner is shutting down; the run is closed so the action stops. */
  signal?: AbortSignal;
  /** How long the workflow may take to start and claim (queueing included). */
  claimTimeoutMs?: number;
  /** How long a claimed run may go without a heartbeat. */
  stallTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}

const DEFAULT_CLAIM_TIMEOUT_MS = ACTIONS_CLAIM_TIMEOUT_MINUTES * 60_000;
const DEFAULT_STALL_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_POLL_MS = 3_000;

function failureOf(report: ExecutorErrorReport | null): Error {
  if (report?.name === 'LocalCredentialsError') return new RunnerSetupError('actions-no-key', report.error);
  if (report?.name === 'PromptDigestMismatchError') return new RunnerSetupError('actions-version-mismatch', report.error);
  // Keep the executor's failureKind for the log, but never retry: nobody would claim the next attempt.
  const original = errorFromExecutorReport(report, 'the GitHub Actions job reported a failure');
  return new RunnerSetupError('actions-failed', original.message);
}

/** Superseded before any action claimed it: nothing ran, nothing to bill or publish. */
export class ActionsRunCancelledError extends Error {
  override readonly name = 'ActionsRunCancelledError';
}

export async function runReviewInActions(
  spec: ReviewExecutorSpec,
  deps: RunInActionsDeps,
): Promise<ReviewExecutorOutput> {
  const now = deps.now ?? Date.now;
  const claimTimeoutMs = deps.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
  const stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const runTimeoutMs = execTimeoutMs(spec);
  const id = uuidv7();
  const db = deps.db;

  // A retried attempt of the same job replaces its earlier run.
  await db
    .updateTable('actions_runs')
    .set({ status: 'closed', spec: null, output: null, finished_at: new Date() })
    .where('job_id', '=', deps.jobId)
    .where('status', 'in', ['pending', 'running'])
    .execute();
  await db
    .insertInto('actions_runs')
    .values({
      id,
      tenant_id: deps.tenantId,
      job_id: deps.jobId,
      repository_id: deps.repositoryId,
      change_request_number: deps.changeRequestNumber,
      head_sha: deps.headSha,
      executor_image: deps.image,
      spec: unkeyedExecutorSpec(spec) as unknown as Record<string, unknown>,
    })
    .execute();
  deps.log('review waiting for GitHub Actions', { runId: id, headSha: deps.headSha, image: deps.image });

  const parkedAt = now();
  let cancelSent = false;
  let finished = false;
  try {
    for (;;) {
      if (deps.signal?.aborted) throw deps.signal.reason ?? new Error('review aborted while waiting for GitHub Actions');
      const row = await db
        .selectFrom('actions_runs')
        .select(['status', 'claimed_at', 'heartbeat_at', 'progress', 'output', 'error'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      if (row.status === 'completed') {
        finished = true;
        return row.output as unknown as ReviewExecutorOutput;
      }
      if (row.status === 'failed') {
        finished = true;
        const report = row.error as ExecutorErrorReport | null;
        deps.log('GitHub Actions executor failed', { runId: id, ...(report ?? {}) });
        throw failureOf(report);
      }
      if (row.status === 'closed') throw new RunnerSetupError('actions-stalled', 'the run was closed');

      const t = now();
      if (row.status === 'pending' && t - parkedAt > claimTimeoutMs) {
        throw new RunnerSetupError('actions-not-claimed');
      }
      if (row.status === 'running') {
        const last = (row.heartbeat_at ?? row.claimed_at)?.getTime() ?? parkedAt;
        if (t - last > stallTimeoutMs) throw new RunnerSetupError('actions-stalled');
        const claimedAt = row.claimed_at?.getTime() ?? parkedAt;
        if (t - claimedAt > runTimeoutMs) throw new RunnerSetupError('actions-timed-out');
        const p = row.progress as { stage?: unknown; done?: unknown; total?: unknown } | null;
        if (p && typeof p.stage === 'string') {
          deps.onProgress?.({
            stage: p.stage,
            ...(typeof p.done === 'number' ? { done: p.done } : {}),
            ...(typeof p.total === 'number' ? { total: p.total } : {}),
          });
        }
      }
      // Cooperative, like the sandbox sentinel: the executor still posts its output so usage is billed.
      if (!cancelSent && (await deps.isCancelled?.())) {
        if (row.status === 'pending') throw new ActionsRunCancelledError('superseded before GitHub Actions claimed it');
        await db.updateTable('actions_runs').set({ cancel_requested: true }).where('id', '=', id).execute();
        cancelSent = true;
      }
      await sleep(pollMs);
    }
  } finally {
    // Closing makes the action's next heartbeat answer 410, so a run nobody waits for stops spending.
    await db
      .updateTable('actions_runs')
      .set({ status: 'closed', spec: null, output: null, ...(finished ? {} : { finished_at: new Date() }) })
      .where('id', '=', id)
      .execute()
      .catch((err) => deps.log('closing GitHub Actions run failed', { runId: id, error: (err as Error)?.message }));
  }
}
