import type { StreamFailureKind } from '@reviewbot/agent-pi';
import { ReviewIncompleteError } from '@reviewbot/review-orchestrator';
import { escapeStructural } from '@reviewbot/publisher';
import type { ExecutorErrorReport } from '@reviewbot/review-runtime';
import type { botMessages } from './locale.js';
import { JobExecutionError } from './supervisor.js';

/**
 * Rebuilds an executor's failure on the control plane with its failureKind, so classifyJobError picks the
 * right backoff (sandbox stderr and GitHub Actions report the same shape).
 */
export function errorFromExecutorReport(report: ExecutorErrorReport | null, fallback: string): Error {
  if (report?.name === 'ReviewIncompleteError') {
    return new ReviewIncompleteError(report.error ?? 'review exploration incomplete', {
      ...(report.failureKind ? { failureKind: report.failureKind as StreamFailureKind } : {}),
      ...(report.failureDetail ? { failureDetail: report.failureDetail } : {}),
      // Without it the control plane retries a wall-clock cut that will just be cut again.
      ...(report.deadlineCut === true ? { deadlineCut: true } : {}),
    });
  }
  return new Error(`review-executor 失败: ${report?.error ?? fallback}`);
}

/**
 * Why a review could not run where the repository asked it to. Never retried: the user has to change
 * something (or re-run the workflow), and the reason is shown on the pull request.
 */
export type RunnerSetupReason =
  | 'actions-fork'
  | 'actions-not-claimed'
  | 'actions-stalled'
  | 'actions-timed-out'
  | 'actions-no-key'
  | 'actions-version-mismatch'
  | 'actions-failed'
  /** A retry asked for a workflow re-run that cannot be made; detail `no-run` or `permission`. */
  | 'actions-no-rerun';

/** Failures a re-run of the workflow can fix, so the status comment offers the retry box. */
export function retryableInActions(error: unknown): boolean {
  return error instanceof RunnerSetupError && error.reason !== 'actions-fork' && error.reason !== 'actions-no-rerun';
}

export class RunnerSetupError extends JobExecutionError {
  readonly reason: RunnerSetupReason;
  /** The executor's own message, for `actions-failed`. */
  readonly detail: string | undefined;

  constructor(reason: RunnerSetupReason, detail?: string) {
    super(`review runner unavailable: ${reason}${detail ? ` (${detail})` : ''}`, 'configuration_invalid', false);
    this.name = 'RunnerSetupError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** Minutes a parked review waits for the workflow to claim it; also quoted in the failure message. */
export const ACTIONS_CLAIM_TIMEOUT_MINUTES = 15;

/** What to tell the user on the check run and status comment; undefined for any other failure. */
export function runnerSetupMessage(m: ReturnType<typeof botMessages>['runnerSetup'], error: unknown): string | undefined {
  if (!(error instanceof RunnerSetupError)) return undefined;
  switch (error.reason) {
    case 'actions-fork':
      return m.actionsFork();
    case 'actions-not-claimed':
      return m.actionsNotClaimed({ minutes: ACTIONS_CLAIM_TIMEOUT_MINUTES });
    case 'actions-stalled':
      return m.actionsStalled();
    case 'actions-timed-out':
      return m.actionsTimedOut();
    case 'actions-no-key':
      return m.actionsNoKey();
    case 'actions-version-mismatch':
      return m.actionsVersionMismatch();
    case 'actions-no-rerun':
      return error.detail === 'permission' ? m.actionsNoRerunPermission() : m.actionsNoRerunRun();
    case 'actions-failed':
      // Written by the user's own workflow: rendered inert and on one line.
      return m.actionsFailed({ detail: escapeStructural(error.detail ?? '').replace(/\s*\n\s*/g, ' ').slice(0, 500) });
  }
}
