/** Message shapes shared by the in-cluster queue runner and the remote HTTP runner transport. */

export interface RunnerRegisterRequest {
  version: string;
  /** One-time token; the server-side grant binds pool, capabilities and capacity. */
  registrationToken: string;
}

export interface RunnerRegisterResponse {
  workerId: string;
  runnerToken: string;
  runnerTokenExpiresAt: string;
}

export interface RunnerHeartbeatRequest {
  workerId: string;
  runningJobs: number;
  mode: 'active' | 'draining' | 'offline';
}

export interface RunnerClaimRequest {
  workerId: string;
  leaseSeconds: number;
}

export interface ClaimedJob {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  /** Enqueuer's W3C trace carrier; parent context of the job span. */
  traceCarrier?: Record<string, string>;
  /** Short-lived; scoped to this job's resources only. */
  jobToken: string;
}

export interface RunnerClaimResponse {
  job: ClaimedJob | null;
}

export interface JobStartRequest {
  jobId: string;
  workerId: string;
}

export interface JobRenewRequest {
  jobId: string;
  workerId: string;
  leaseSeconds: number;
}

export interface JobRenewResponse {
  jobToken: string;
  jobTokenExpiresAt: string;
}

export interface JobCompleteRequest {
  jobId: string;
  workerId: string;
  outcome: 'completed' | 'failed';
  /** Unknown values are treated as `internal_bug`. */
  failureClass?: string;
  /** Omitted: the queue decides from `failureClass`. */
  retryable?: boolean;
  message?: string;
}

export const RUNNER_ENDPOINTS = {
  register: 'POST /runner/v1/register',
  heartbeat: 'POST /runner/v1/heartbeat',
  claim: 'POST /runner/v1/jobs/claim',
  start: 'POST /runner/v1/jobs/{id}/start',
  renew: 'POST /runner/v1/jobs/{id}/renew',
  complete: 'POST /runner/v1/jobs/{id}/complete',
} as const;

/**
 * Reviews executed in the repository's GitHub Actions: the action proves which repository and pull request
 * it runs for with a GitHub OIDC token (audience {@link ACTIONS_OIDC_AUDIENCE}), gets the parked executor
 * spec and a per-run token, and posts the output back.
 */
export const ACTIONS_OIDC_AUDIENCE = 'winnowl';

export const ACTIONS_ENDPOINTS = {
  /** Public: the executor image matching the server's version. */
  executor: 'GET /v1/actions/executor',
  claim: 'POST /v1/actions/claim',
  heartbeat: 'POST /v1/actions/runs/{id}/heartbeat',
  complete: 'POST /v1/actions/runs/{id}/complete',
} as const;

export interface ActionsExecutorResponse {
  image: string;
}

export interface ActionsClaimRequest {
  /** `github.event.pull_request.head.sha`; the OIDC token's own sha is the merge commit. */
  headSha: string;
}

export interface ActionsClaimResponse {
  runId: string;
  /** Bearer for heartbeat / complete of this run only. */
  token: string;
  /** A `ReviewExecutorSpec` without any key (`unkeyedExecutorSpec`). */
  spec: Record<string, unknown>;
}

export interface ActionsHeartbeatRequest {
  progress?: { stage: string; done?: number; total?: number };
}

export interface ActionsHeartbeatResponse {
  /** Stop at the next billable step and still post the output (the review was superseded). */
  cancel: boolean;
}

export type ActionsCompleteRequest =
  | { output: Record<string, unknown> }
  | { error: { error?: string; name?: string; failureKind?: string; failureDetail?: string; deadlineCut?: boolean } };

/**
 * `not_ready`: nothing parked yet for this pull request head (the runner may still be preparing), retry.
 * The rest are final; `message` says what to change.
 */
export type ActionsErrorCode =
  | 'not_ready'
  | 'invalid_token'
  | 'repository_unknown'
  | 'run_closed'
  | 'invalid_request';

export interface ActionsErrorBody {
  error: ActionsErrorCode;
  message: string;
}

/** The executor image CI published for this server's commit; prompt digests must match the control plane's. */
export function actionsExecutorImage(env: Record<string, string | undefined>): string {
  if (env.ACTIONS_EXECUTOR_IMAGE) return env.ACTIONS_EXECUTOR_IMAGE;
  const version = env.APP_VERSION?.trim();
  return version ? `ghcr.io/lollipopkit/winnowl:sha-${version}` : 'ghcr.io/lollipopkit/winnowl:latest';
}
