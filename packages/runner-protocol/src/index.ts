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
