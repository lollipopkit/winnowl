import { runWithTenant, type Db } from '@reviewbot/db';
import { LeaseKeeper } from './lease-keeper.js';
import {
  claimJob,
  completeJob,
  failJob,
  heartbeatJob,
  heartbeatWorker,
  releaseJobOnShutdown,
  startJob,
  sweepExpiredLeases,
  type Job,
  type JobFailureClass,
  type SweptJob,
} from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { sweepStaleProgress } from './review-progress.js';
import {
  recordJob,
  withRemoteTraceCarrier,
  withSpan,
  type Span,
  type Tracer,
} from '@reviewbot/telemetry';

export interface JobContext {
  job: Job;
  db: Db;
  sandbox: SandboxBackend;
  /** Fires on lease loss or shutdown; long tasks should pass it to cancellable IO/subprocesses. */
  signal: AbortSignal;
  log: (message: string, data?: Record<string, unknown>) => void;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export type JobHandlerDb = JobContext['db'];

/** Thrown by a handler to choose the failure class. */
export class JobExecutionError extends Error {
  readonly failureClass: JobFailureClass;
  readonly retryable: boolean | undefined;

  constructor(message: string, failureClass: JobFailureClass, retryable?: boolean) {
    super(message);
    this.name = 'JobExecutionError';
    this.failureClass = failureClass;
    this.retryable = retryable;
  }
}

/**
 * Thrown when a handler stops midway because of its abort signal (shutdown or lease loss).
 * A normal return is treated as "done" and completed, so an unfinished handler must throw this
 * instead of returning, or the job is recorded complete and never rerun.
 */
export class JobInterruptedError extends Error {
  constructor(message = 'job was interrupted by its abort signal') {
    super(message);
    this.name = 'JobInterruptedError';
  }
}

/** Handlers call this before every early-exit path. */
export function throwIfInterrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new JobInterruptedError();
}

/**
 * Classify a job failure. Provider errors are duck-typed on HTTP `status` to avoid depending on
 * provider-contracts: 429/5xx retryable; 401/403 policy_denied; 404 repository_invalid; other 4xx
 * not retried unless flagged. Anything unrecognised is `internal_bug`.
 */
export function classifyJobError(error: unknown): {
  failureClass: JobFailureClass;
  retryable: boolean | undefined;
} {
  if (error instanceof JobExecutionError) {
    return { failureClass: error.failureClass, retryable: error.retryable };
  }
  if (error instanceof JobInterruptedError)
    return { failureClass: 'retryable_runner', retryable: true };
  // ReviewIncompleteError is matched by name to avoid a cross-package dependency.
  // content_filter / context_overflow would fail identically on retry, so they are terminal.
  // Gateway/model faults use retryable_model for its minute-scale backoff (runner backoff is seconds).
  // deadlineCut is checked first: a retry burns the same wall clock, and the deadline abort itself
  // tends to surface as failureKind=timeout/unknown.
  if ((error as Error)?.name === 'ReviewIncompleteError') {
    if ((error as { deadlineCut?: boolean }).deadlineCut === true)
      return { failureClass: 'budget_exhausted', retryable: false };
    const kind = (error as { failureKind?: string }).failureKind;
    if (kind === 'content_filter' || kind === 'context_overflow')
      return { failureClass: 'retryable_model', retryable: false };
    if (kind === 'gateway_transport' || kind === 'timeout' || kind === 'model_unavailable')
      return { failureClass: 'retryable_model', retryable: true };
    return { failureClass: 'retryable_runner', retryable: true };
  }
  if ((error as Error)?.name === 'SandboxCapacityError')
    return { failureClass: 'retryable_runner', retryable: true };
  // A sandbox-host 404 means the sandbox/workspace is gone (retryable); it must be matched before
  // the generic rule below, where 404 means "repository does not exist" and is terminal.
  if ((error as Error)?.name === 'AgentRequestError' && (error as { status?: unknown }).status === 404)
    return { failureClass: 'retryable_runner', retryable: true };
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number') {
    if (status === 429 || status >= 500)
      return { failureClass: 'retryable_provider', retryable: true };
    if (status === 401 || status === 403)
      return { failureClass: 'policy_denied', retryable: false };
    if (status === 404) return { failureClass: 'repository_invalid', retryable: false };
    const retryable = (error as { retryable?: boolean })?.retryable;
    return { failureClass: 'retryable_provider', retryable: retryable ?? false };
  }
  return { failureClass: 'internal_bug', retryable: false };
}

/**
 * A runner lane: an independent in-flight pool that only claims the job types it matches, so one
 * long job cannot block unrelated work (claim priority cannot help once every slot is taken).
 * Only sandbox-using types share the small sandbox lane, since sandbox memory is the scarce resource.
 */
export interface RunnerLane {
  name: string;
  /** Only claim these job types (omitted / empty = any). */
  types?: string[];
  /** Never claim these job types (omitted / empty = none excluded). */
  excludeTypes?: string[];
  /** Max in-flight jobs in this lane (clamped to >= 1). */
  concurrency: number;
}

/** Sum of lane concurrencies: the minimum `max_concurrency` the worker row needs. */
export function totalLaneConcurrency(lanes: readonly RunnerLane[]): number {
  return lanes.reduce((sum, lane) => sum + Math.max(1, lane.concurrency), 0);
}

export interface SupervisorOptions {
  db: Db;
  sandbox: SandboxBackend;
  workerId: string;
  handlers: Record<string, JobHandler>;
  leaseSeconds?: number;
  heartbeatMs?: number;
  /** Expired-lease sweep interval (default 60s). */
  sweepIntervalMs?: number;
  /**
   * Defaults to a single unrestricted lane with concurrency 1. The worker row's `max_concurrency`
   * must be at least the sum of lane concurrencies, or `claimJob` refuses claims early.
   */
  lanes?: RunnerLane[];
  /** Called for jobs the lease sweep failed terminally on timeout, e.g. to post a neutral check. */
  onJobTimedOut?: (job: SweptJob) => Promise<void>;
  logger?: (message: string, data?: Record<string, unknown>) => void;
  tracer?: Tracer;
}

/** Jobs are rerun from the start on retry, never resumed from a mid-stage checkpoint. */
export class Supervisor {
  private stopped = false;
  private readonly leaseSeconds: number;
  private readonly heartbeatMs: number;
  private readonly sweepIntervalMs: number;
  private readonly lanes: RunnerLane[];
  private lastSweepAt = 0;
  private readonly log: (message: string, data?: Record<string, unknown>) => void;
  /** Released back to the queue on shutdown with their attempt refunded (see `releaseJobOnShutdown`). */
  private readonly inFlight = new Map<string, string>(); // job id → job type
  /**
   * Set by `abortInFlight`: from here on in-flight handlers are being torn down by shutdown.
   * Distinct from `stopped` — a graceful drain stops claiming but lets in-flight jobs finish,
   * and those jobs must still persist their own failures normally.
   */
  private aborting = false;
  private readonly abortControllers = new Map<string, AbortController>();
  private lastWorkerHeartbeatAt = 0;

  constructor(private readonly options: SupervisorOptions) {
    this.leaseSeconds = options.leaseSeconds ?? 90;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    this.lanes = options.lanes ?? [{ name: 'default', concurrency: 1 }];
    if (this.lanes.length === 0) throw new Error('Supervisor needs at least one lane');
    this.log = options.logger ?? (() => undefined);
  }

  requestStop(): void {
    this.stopped = true;
  }

  inFlightJobs(): { id: string; type: string }[] {
    return [...this.inFlight].map(([id, type]) => ({ id, type }));
  }

  /** Abort every in-flight handler; returns the job ids held when shutdown began. */
  abortInFlight(reason: Error = new Error('runner supervisor is shutting down')): string[] {
    this.aborting = true;
    const ids = [...this.inFlight.keys()];
    for (const id of ids) this.abortControllers.get(id)?.abort(reason);
    return ids;
  }

  /**
   * Requeue in-flight jobs with their attempt refunded; returns how many were released.
   * Must finish within the SIGTERM grace period. Never throws: an unreleased job is later
   * recovered by the lease sweep at the cost of one attempt.
   */
  async releaseInFlight(ids: string[] = [...this.inFlight.keys()]): Promise<number> {
    let released = 0;
    for (const id of ids) {
      const ok = await releaseJobOnShutdown(this.options.db, id, this.options.workerId).catch(
        () => false,
      );
      if (ok) released += 1;
    }
    return released;
  }

  /**
   * Reclaim expired leases when due, so jobs orphaned by a crash/restart do not stay `running`
   * and swallow new triggers via dedupe. Idempotent and safe across concurrent workers.
   * Also clears review progress left behind by terminal jobs (see `sweepStaleProgress`).
   */
  async sweepIfDue(now = Date.now()): Promise<void> {
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    try {
      const { requeued, failed, timedOut } = await sweepExpiredLeases(this.options.db);
      if (requeued > 0 || failed > 0) this.log('expired leases swept', { requeued, failed });
      for (const job of timedOut) {
        await this.options.onJobTimedOut?.(job).catch((error) =>
          this.log('job timeout ack failed', {
            jobId: job.id,
            type: job.type,
            error: String(error),
          }),
        );
      }
    } catch (error) {
      this.log('lease sweep failed', { error: String(error) });
    }
    try {
      const stale = await sweepStaleProgress(this.options.db);
      if (stale > 0) this.log('stale review progress swept', { rows: stale });
    } catch (error) {
      this.log('review progress sweep failed', { error: String(error) });
    }
  }

  private async claimNext(
    filter: Pick<RunnerLane, 'types' | 'excludeTypes'> = {},
  ): Promise<Job | null> {
    const { db, workerId } = this.options;
    const job = await claimJob(db, {
      workerId,
      leaseSeconds: this.leaseSeconds,
      ...(filter.types?.length ? { types: filter.types } : {}),
      ...(filter.excludeTypes?.length ? { excludeTypes: filter.excludeTypes } : {}),
    });
    return job ?? null;
  }

  /** Claim and process one job; false when nothing was claimable. */
  async runOnce(): Promise<boolean> {
    const job = await this.claimNext();
    if (!job) return false;
    await this.process(job);
    return true;
  }

  private process(job: Job): Promise<void> {
    // RLS: all DB access inside the handler is scoped to the job's tenant; claiming happens outside
    // any tenant context. The span is parented to the enqueuer's trace carrier.
    return withRemoteTraceCarrier(job.traceCarrier, () =>
      runWithTenant(job.tenantId, () => this.processInner(job)),
    );
  }

  private async processInner(job: Job): Promise<void> {
    const { db, workerId } = this.options;
    this.inFlight.set(job.id, job.type);
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);
    let keeper: LeaseKeeper | undefined;
    let leaseFailure: JobExecutionError | undefined;

    // Failures are persisted via failJob rather than thrown, so the span records outcome as attributes.
    const startedMs = Date.now();
    const execute = async (span?: Span): Promise<void> => {
      try {
        const started = await startJob(db, job.id, workerId);
        if (!started) {
          this.log('job lease lost before start', { jobId: job.id, type: job.type });
          return;
        }
        const handler = this.options.handlers[job.type];
        if (!handler) {
          throw new JobExecutionError(`无处理器: ${job.type}`, 'internal_bug', false);
        }

        keeper = new LeaseKeeper({
          leaseMs: this.leaseSeconds * 1000,
          intervalMs: this.heartbeatMs,
          renew: () => heartbeatJob(db, job.id, workerId, this.leaseSeconds),
          onLost: (error) => {
            leaseFailure = new JobExecutionError(
              `job lease heartbeat failed: ${error.message}`,
              'retryable_runner',
              true,
            );
            controller.abort(leaseFailure);
            this.log('job lease lost; cancellation requested', {
              jobId: job.id,
              type: job.type,
              error: error.message,
            });
          },
        });
        keeper.start();

        await handler({
          job,
          db,
          sandbox: this.options.sandbox,
          signal: controller.signal,
          log: this.log,
        });
        if (leaseFailure) throw leaseFailure;
        /*
         * A normal return means the work is done, even if shutdown aborted the signal meanwhile.
         * `completeJob` is fenced on lease owner + expiry; discarding the success instead would
         * requeue a job that may already have published comments and been billed.
         */
        const completed = await completeJob(db, job.id, workerId);
        if (!completed)
          throw new JobExecutionError(
            'job lease was lost before completion',
            'retryable_runner',
            true,
          );
        span?.setAttribute('job.outcome', 'completed');
        recordJob(job.type, 'completed', (Date.now() - startedMs) / 1000);
        this.log('job completed', { jobId: job.id, type: job.type });
      } catch (error) {
        // On shutdown, index.ts releases jobs once handlers stop; do not record a failure here.
        if (this.aborting && controller.signal.aborted && !leaseFailure) {
          this.log('job interrupted by supervisor shutdown', { jobId: job.id, type: job.type });
          return;
        }
        const { failureClass, retryable } = classifyJobError(error);
        let persisted = false;
        let attempt = 0;
        // Keyed on `aborting`, not `stopped`: a job that fails while the worker drains must still
        // record its failure; only an aborting shutdown gives up and leaves it to lease recovery.
        while (!persisted && !this.aborting && !leaseFailure) {
          try {
            const result = await failJob(db, job.id, workerId, {
              failureClass,
              message: (error as Error).message,
              ...(retryable !== undefined ? { retryable } : {}),
            });
            persisted = result.persisted;
            if (!persisted) {
              leaseFailure = new JobExecutionError(
                'job lease was lost before failure could be persisted',
                'retryable_runner',
                true,
              );
              controller.abort(leaseFailure);
            }
          } catch (failed) {
            attempt += 1;
            this.log('job failure persistence retrying', {
              jobId: job.id,
              type: job.type,
              attempt,
              error: String(failed),
            });
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(5_000, 100 * 2 ** Math.min(attempt - 1, 6))),
            );
          }
        }
        if (!persisted) {
          this.log('job failure not persisted; lease recovery will decide the outcome', {
            jobId: job.id,
            type: job.type,
            aborting: this.aborting,
            leaseLost: Boolean(leaseFailure),
          });
          return;
        }
        span?.setAttributes({ 'job.outcome': 'failed', 'job.failure_class': failureClass });
        recordJob(job.type, 'failed', (Date.now() - startedMs) / 1000);
        // failureDetail is the raw upstream model/gateway error, logged when present.
        const detail = (error as { failureDetail?: string }).failureDetail;
        this.log('job failed', {
          jobId: job.id,
          type: job.type,
          failureClass,
          ...(detail ? { failureDetail: detail } : {}),
        });
      } finally {
        keeper?.stop();
        this.inFlight.delete(job.id);
        this.abortControllers.delete(job.id);
      }
    };
    if (this.options.tracer) {
      await withSpan(this.options.tracer, `job.${job.type}`, (span) => execute(span), {
        'job.id': job.id,
        'job.type': job.type,
      });
    } else {
      await execute();
    }
  }

  /**
   * Claim and process until draining/offline or requestStop. Each iteration claims at most one job
   * per lane with a free slot; before returning, waits for all in-flight jobs.
   */
  async run(pollMs = 1000): Promise<void> {
    const { db, workerId } = this.options;
    const lanes = this.lanes.map((lane) => ({
      ...lane,
      limit: Math.max(1, lane.concurrency),
      inflight: new Set<Promise<void>>(),
    }));
    const all = (): Promise<void>[] => lanes.flatMap((l) => [...l.inflight]);
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    while (!this.stopped) {
      // A DB failure here must not end the loop: in-flight jobs keep running and the next iteration retries.
      let claimed = false;
      try {
        await this.heartbeatWorkerIfDue(db, workerId);
        const worker = await db
          .selectFrom('workers')
          .select('mode')
          .where('id', '=', workerId)
          .executeTakeFirst();
        if (!worker || worker.mode !== 'active') {
          this.log('draining: 停止领取新 Job', { workerId, mode: worker?.mode ?? 'unregistered' });
          break;
        }
        await this.sweepIfDue();
        for (const lane of lanes) {
          if (lane.inflight.size >= lane.limit) continue;
          const job = await this.claimNext(lane);
          if (!job) continue;
          // requestStop can arrive while claimNext is waiting on its transaction. Do not start a
          // handler that shutdown's in-flight snapshot could not have observed.
          if (this.stopped) {
            await releaseJobOnShutdown(db, job.id, workerId).catch(() => false);
            continue;
          }
          // process() persists handler errors itself; this catch only prevents an unhandled rejection.
          const p = this.process(job)
            .catch((error) =>
              this.log('job processing crashed', {
                jobId: job.id,
                type: job.type,
                lane: lane.name,
                error: String(error),
              }),
            )
            .finally(() => lane.inflight.delete(p));
          lane.inflight.add(p);
          claimed = true;
        }
      } catch (error) {
        this.log('run loop iteration failed; retrying', { workerId, error: String(error) });
        await sleep(Math.max(1, pollMs));
        continue;
      }
      if (claimed) continue;
      const pending = all();
      const wakeMs = Math.min(Math.max(1, pollMs), this.heartbeatMs);
      await (pending.length > 0 ? Promise.race([...pending, sleep(wakeMs)]) : sleep(wakeMs));
    }
    await this.settleInFlight(all, sleep);
  }

  /**
   * Wait for in-flight jobs while keeping the worker heartbeat alive: other runners sweep sandboxes
   * whose owner missed the 90s liveness window, which would delete sandboxes of jobs still finishing.
   */
  private async settleInFlight(
    all: () => Promise<void>[],
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    const { db, workerId } = this.options;
    for (;;) {
      const pending = all();
      if (pending.length === 0) return;
      const tickMs = Math.max(1, Math.min(this.heartbeatMs, 5_000));
      await Promise.race([Promise.allSettled(pending), sleep(tickMs)]);
      await this.heartbeatWorkerIfDue(db, workerId);
    }
  }

  private async heartbeatWorkerIfDue(db: Db, workerId: string): Promise<void> {
    if (Date.now() - this.lastWorkerHeartbeatAt < this.heartbeatMs) return;
    try {
      await heartbeatWorker(db, workerId);
      this.lastWorkerHeartbeatAt = Date.now();
    } catch (error) {
      this.log('worker heartbeat failed', { workerId, error: String(error) });
    }
  }
}
