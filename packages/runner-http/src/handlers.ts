import type { Db } from '@reviewbot/db';
import {
  claimJob,
  completeJob,
  failJob,
  heartbeatJob,
  heartbeatWorker,
  isJobFailureClass,
  registerWorker,
  setWorkerMode,
  startJob,
} from '@reviewbot/queue';
import type {
  ClaimedJob,
  JobCompleteRequest,
  JobRenewRequest,
  RunnerClaimRequest,
  RunnerHeartbeatRequest,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
} from '@reviewbot/runner-protocol';
import type { TokenAuthority } from './tokens.js';

export interface HandlerResult {
  status: number;
  body: unknown;
}

const unauthorized: HandlerResult = { status: 401, body: { error: 'unauthorized' } };
const MIN_JOB_LEASE_SECONDS = 30;
const MAX_JOB_LEASE_SECONDS = 300;
const MAX_JOB_TOKEN_TTL_SECONDS = 3_600;

function boundedLeaseSeconds(value: number): number | null {
  return Number.isInteger(value) && value >= MIN_JOB_LEASE_SECONDS && value <= MAX_JOB_LEASE_SECONDS
    ? value
    : null;
}

function jobTokenTtlSeconds(deps: RunnerHttpDeps): number {
  const configured = deps.jobTokenTtlSeconds ?? MAX_JOB_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(configured) || configured < MIN_JOB_LEASE_SECONDS)
    return MAX_JOB_TOKEN_TTL_SECONDS;
  return Math.min(configured, MAX_JOB_TOKEN_TTL_SECONDS);
}

/**
 * Framework-free `{status, body}` handlers. Auth: register uses the one-time registration token,
 * job routes use the job token (current job only), everything else the runner token.
 */
export interface RunnerHttpDeps {
  db: Db;
  tokens: TokenAuthority;
  runnerTokenTtlSeconds?: number;
  jobTokenTtlSeconds?: number;
}

/** POST /runner/v1/register — registration token -> runner token + workerId. */
export async function handleRegister(
  deps: RunnerHttpDeps,
  req: RunnerRegisterRequest,
): Promise<HandlerResult> {
  const grant = deps.tokens.verifyRegistrationToken(req.registrationToken);
  if (!grant) return unauthorized;
  const workerId = await registerWorker(deps.db, {
    poolId: grant.poolId,
    version: req.version,
    capabilities: grant.capabilities,
    maxConcurrency: grant.maxConcurrency,
  });
  const ttl = deps.runnerTokenTtlSeconds ?? 3600;
  const runnerToken = deps.tokens.issueRunnerToken(workerId, ttl);
  const body: RunnerRegisterResponse = {
    workerId,
    runnerToken,
    runnerTokenExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
  return { status: 200, body };
}

/** POST /runner/v1/heartbeat — runner token. */
export async function handleHeartbeat(
  deps: RunnerHttpDeps,
  authToken: string,
  req: RunnerHeartbeatRequest,
): Promise<HandlerResult> {
  const claims = deps.tokens.verifyRunnerToken(authToken);
  if (!claims || claims.workerId !== req.workerId) return unauthorized;
  await heartbeatWorker(deps.db, req.workerId);
  if (req.mode === 'draining' || req.mode === 'offline')
    await setWorkerMode(deps.db, req.workerId, req.mode);
  return { status: 204, body: null };
}

/** POST /runner/v1/jobs/claim — runner token; issues a job token. */
export async function handleClaim(
  deps: RunnerHttpDeps,
  authToken: string,
  req: RunnerClaimRequest,
): Promise<HandlerResult> {
  const claims = deps.tokens.verifyRunnerToken(authToken);
  if (!claims || claims.workerId !== req.workerId) return unauthorized;
  const leaseSeconds = boundedLeaseSeconds(req.leaseSeconds);
  if (leaseSeconds === null) return { status: 400, body: { error: 'lease_seconds_out_of_range' } };
  const job = await claimJob(deps.db, {
    workerId: req.workerId,
    leaseSeconds,
  });
  if (!job) return { status: 200, body: { job: null } };
  const jobToken = deps.tokens.issueJobToken(job.id, req.workerId, jobTokenTtlSeconds(deps));
  const claimed: ClaimedJob = {
    id: job.id,
    tenantId: job.tenantId,
    type: job.type,
    payload: job.payload as Record<string, unknown>,
    attemptCount: job.attemptCount,
    ...(job.traceCarrier ? { traceCarrier: job.traceCarrier } : {}),
    jobToken,
  };
  return { status: 200, body: { job: claimed } };
}

/** POST /runner/v1/jobs/:id/renew — Job Token; extend an owned lease and rotate the token. */
export async function handleRenew(
  deps: RunnerHttpDeps,
  authToken: string,
  jobId: string,
  req: JobRenewRequest,
): Promise<HandlerResult> {
  const claims = deps.tokens.verifyJobToken(authToken);
  if (!claims || claims.jobId !== jobId || claims.workerId !== req.workerId) return unauthorized;
  const leaseSeconds = boundedLeaseSeconds(req.leaseSeconds);
  if (leaseSeconds === null) return { status: 400, body: { error: 'lease_seconds_out_of_range' } };
  const renewed = await heartbeatJob(deps.db, jobId, req.workerId, leaseSeconds);
  if (!renewed) return { status: 409, body: { error: 'not_leased' } };
  const ttl = jobTokenTtlSeconds(deps);
  return {
    status: 200,
    body: {
      jobToken: deps.tokens.issueJobToken(jobId, req.workerId, ttl),
      jobTokenExpiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    },
  };
}

/** POST /runner/v1/jobs/:id/start — job token (must match the job). */
export async function handleStart(
  deps: RunnerHttpDeps,
  authToken: string,
  jobId: string,
): Promise<HandlerResult> {
  const claims = deps.tokens.verifyJobToken(authToken);
  if (!claims || claims.jobId !== jobId) return unauthorized;
  const ok = await startJob(deps.db, jobId, claims.workerId);
  return ok ? { status: 204, body: null } : { status: 409, body: { error: 'not_leased' } };
}

/** POST /runner/v1/jobs/:id/complete — job token; retry policy lives in the queue. */
export async function handleComplete(
  deps: RunnerHttpDeps,
  authToken: string,
  jobId: string,
  req: JobCompleteRequest,
): Promise<HandlerResult> {
  const claims = deps.tokens.verifyJobToken(authToken);
  if (!claims || claims.jobId !== jobId || claims.workerId !== req.workerId) return unauthorized;
  if (req.outcome === 'completed') {
    const ok = await completeJob(deps.db, jobId, req.workerId);
    return ok ? { status: 204, body: null } : { status: 409, body: { error: 'not_leased' } };
  }
  const { requeued, persisted } = await failJob(deps.db, jobId, req.workerId, {
    // An unrecognized class (typo, old worker) must not pick the retry policy.
    failureClass: isJobFailureClass(req.failureClass) ? req.failureClass : 'internal_bug',
    ...(typeof req.retryable === 'boolean' ? { retryable: req.retryable } : {}),
    message: req.message ?? '(worker reported failure without message)',
  });
  if (!persisted) return { status: 409, body: { error: 'not_leased' } };
  return { status: 200, body: { requeued } };
}
