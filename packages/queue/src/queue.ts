import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { sql } from 'kysely';
import { backoffPolicyFor, computeBackoffSeconds } from './backoff.js';
import {
  isRetryableFailure,
  type ClaimOptions,
  type EnqueueInput,
  type FailInput,
  type Job,
} from './types.js';

interface JobRow {
  id: string;
  tenant_id: string;
  type: string;
  status: string;
  priority: number;
  dedupe_key: string | null;
  payload: Record<string, unknown>;
  runner_selector: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  cancellation_requested: boolean;
  lease_owner: string | null;
  trace_context: Record<string, string> | null;
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    status: row.status as Job['status'],
    priority: row.priority,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    runnerSelector: row.runner_selector,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    cancellationRequested: row.cancellation_requested,
    leaseOwner: row.lease_owner,
    ...(row.trace_context ? { traceCarrier: row.trace_context } : {}),
  };
}

/** Injected at bootstrap so the queue package has no telemetry dependency. */
let traceCarrierProvider: (() => Record<string, string> | undefined) | undefined;

export function setJobTraceCarrierProvider(
  provider: (() => Record<string, string> | undefined) | undefined,
): void {
  traceCarrierProvider = provider;
}

/** Returns the existing job (deduped=true) when an active job holds the same dedupe_key. */
export async function enqueueJob(
  db: Db,
  input: EnqueueInput,
): Promise<{ jobId: string; deduped: boolean }> {
  const id = uuidv7();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inserted = await db
      .insertInto('jobs')
      .values({
        id,
        tenant_id: input.tenantId,
        type: input.type,
        status: 'queued',
        priority: input.priority ?? 100,
        dedupe_key: input.dedupeKey ?? null,
        payload: input.payload,
        runner_selector: input.runnerSelector ?? {},
        trace_context: input.traceCarrier ?? traceCarrierProvider?.() ?? null,
        // DB clock, matching claim's `available_at <= now()`; a client clock slightly ahead would make fresh jobs unclaimable.
        available_at: input.availableAt ?? sql`now()`,
        lease_owner: null,
        lease_expires_at: null,
        attempt_count: 0,
        max_attempts: input.maxAttempts ?? 3,
        cancellation_requested: false,
        superseded_by: null,
        last_error: null,
        created_at: new Date(),
        started_at: null,
        completed_at: null,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) return { jobId: inserted.id, deduped: false };
    if (input.dedupeKey) {
      const existing = await db
        .selectFrom('jobs')
        .select('id')
        .where('tenant_id', '=', input.tenantId)
        .where('dedupe_key', '=', input.dedupeKey)
        .where('status', 'in', ['queued', 'leased', 'running'])
        .executeTakeFirst();
      if (existing) return { jobId: existing.id, deduped: true };
      // The conflicting active row can finish between INSERT and this lookup. Retry once now
      // that the partial unique-key slot is free instead of surfacing a stale 23505.
      if (attempt === 0) continue;
    }
    throw new Error('job insert conflicted without an active dedupe match');
  }
  throw new Error('job enqueue retry exhausted');
}

/** runner_selector must be contained in the worker's capabilities; draining/offline workers get nothing. */
export async function claimJob(db: Db, opts: ClaimOptions): Promise<Job | null> {
  return db.transaction().execute(async (trx) => {
    // Locking the worker row makes the mode check and claim atomic with respect to setWorkerMode(draining).
    const worker = await trx
      .selectFrom('workers')
      .innerJoin('runner_pools', 'runner_pools.id', 'workers.pool_id')
      .select([
        'workers.mode as mode',
        'workers.capabilities as capabilities',
        'workers.max_concurrency as max_concurrency',
        'runner_pools.tenant_id as pool_tenant_id',
      ])
      .where('workers.id', '=', opts.workerId)
      .forUpdate()
      .executeTakeFirst();
    if (!worker || worker.mode !== 'active') return null;

    const active = await trx
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('lease_owner', '=', opts.workerId)
      .where('status', 'in', ['leased', 'running'])
      .executeTakeFirstOrThrow();
    const activeCount = Number(active.n);
    if (activeCount >= worker.max_concurrency) {
      await trx
        .updateTable('workers')
        .set({ running_jobs: activeCount })
        .where('id', '=', opts.workerId)
        .execute();
      return null;
    }

    // Capabilities come from the worker registry, never from the caller.
    const caps = JSON.stringify(worker.capabilities ?? {});
    // Runner lane filters. An empty array means "no restriction" for both: `any('{}')` is always
    // false, so an empty include list would silently become a lane that never claims anything.
    const typeFilter =
      opts.types && opts.types.length > 0 ? sql`and type = any(${opts.types}::text[])` : sql``;
    const excludeTypeFilter =
      opts.excludeTypes && opts.excludeTypes.length > 0
        ? sql`and type <> all(${opts.excludeTypes}::text[])`
        : sql``;
    const tenantFilter = worker.pool_tenant_id
      ? sql`and tenant_id = ${worker.pool_tenant_id}::uuid`
      : sql``;
    const result = await sql<JobRow>`
      with candidate as (
        select id from jobs
        where status = 'queued'
          and cancellation_requested = false
          and available_at <= now()
          and runner_selector <@ ${caps}::jsonb
          ${tenantFilter}
          ${typeFilter}
          ${excludeTypeFilter}
        order by priority desc, created_at
        for update skip locked
        limit 1
      )
      update jobs
      set status = 'leased',
          lease_owner = ${opts.workerId}::uuid,
          lease_expires_at = now() + make_interval(secs => ${opts.leaseSeconds}),
          attempt_count = attempt_count + 1
      where id in (select id from candidate)
      returning *
    `.execute(trx);

    const row = result.rows[0];
    if (!row) return null;

    await trx
      .insertInto('job_attempts')
      .values({
        id: uuidv7(),
        job_id: row.id,
        attempt_number: row.attempt_count,
        worker_id: opts.workerId,
        status: 'running',
        error: null,
        started_at: new Date(),
        completed_at: null,
      })
      .execute();

    await trx
      .updateTable('workers')
      .set({ running_jobs: activeCount + 1 })
      .where('id', '=', opts.workerId)
      .execute();

    return mapJob(row);
  });
}

/** leased → running */
export async function startJob(db: Db, jobId: string, workerId: string): Promise<boolean> {
  const res = await db
    .updateTable('jobs')
    .set({ status: 'running', started_at: sql`coalesce(started_at, now())` })
    .where('id', '=', jobId)
    .where('lease_owner', '=', workerId)
    .where('status', '=', 'leased')
    .where('lease_expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

/**
 * On shutdown, requeues an in-flight job immediately and refunds the attempt claimJob counted,
 * so deploys do not consume attempts. Also removes the attempt row that would stay `running`.
 */
export async function releaseJobOnShutdown(
  db: Db,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const owned = await trx
      .selectFrom('jobs')
      .select(['attempt_count', 'cancellation_requested'])
      .where('id', '=', jobId)
      .where('lease_owner', '=', workerId)
      .where('status', 'in', ['leased', 'running'])
      .where('lease_expires_at', '>', sql<Date>`now()`)
      .forUpdate()
      .executeTakeFirst();
    if (!owned) return false;
    const cancelled = owned.cancellation_requested;
    await trx
      .updateTable('jobs')
      .set({
        status: cancelled ? 'superseded' : 'queued',
        lease_owner: null,
        lease_expires_at: null,
        available_at: sql`now()`,
        completed_at: cancelled ? new Date() : null,
        attempt_count: cancelled ? owned.attempt_count : sql`greatest(0, attempt_count - 1)`,
      })
      .where('id', '=', jobId)
      .where('lease_owner', '=', workerId)
      .where('status', 'in', ['leased', 'running'])
      .execute();
    if (cancelled) {
      await trx
        .updateTable('job_attempts')
        .set({
          status: 'cancelled',
          error: { class: 'retryable_runner', message: 'job cancelled before shutdown release' },
          completed_at: new Date(),
        })
        .where('job_id', '=', jobId)
        .where('attempt_number', '=', owned.attempt_count)
        .where('worker_id', '=', workerId)
        .where('status', '=', 'running')
        .execute();
    } else {
      // The refunded attempt_number is reused next claim, so delete this attempt row in the same transaction.
      await trx
        .deleteFrom('job_attempts')
        .where('job_id', '=', jobId)
        .where('attempt_number', '=', owned.attempt_count)
        .where('worker_id', '=', workerId)
        .where('status', '=', 'running')
        .execute();
    }
    await trx
      .updateTable('workers')
      .set({ running_jobs: sql`greatest(0, running_jobs - 1)` })
      .where('id', '=', workerId)
      .execute();
    return true;
  });
}

export async function heartbeatJob(
  db: Db,
  jobId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const res = await db
    .updateTable('jobs')
    .set({ lease_expires_at: sql`now() + make_interval(secs => ${leaseSeconds})` })
    .where('id', '=', jobId)
    .where('lease_owner', '=', workerId)
    .where('status', 'in', ['leased', 'running'])
    .where('lease_expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export async function completeJob(db: Db, jobId: string, workerId: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const owned = await trx
      .selectFrom('jobs')
      .select(['attempt_count', 'cancellation_requested'])
      .where('id', '=', jobId)
      .where('lease_owner', '=', workerId)
      .where('status', 'in', ['leased', 'running'])
      .where('lease_expires_at', '>', sql<Date>`now()`)
      .forUpdate()
      .executeTakeFirst();
    if (!owned) return false;
    const completedAt = new Date();
    const terminalStatus = owned.cancellation_requested ? 'superseded' : 'completed';
    await trx
      .updateTable('jobs')
      .set({
        status: terminalStatus,
        completed_at: completedAt,
        lease_owner: null,
        lease_expires_at: null,
      })
      .where('id', '=', jobId)
      .where('lease_owner', '=', workerId)
      .where('status', 'in', ['leased', 'running'])
      .execute();
    await trx
      .updateTable('job_attempts')
      .set({
        status: owned.cancellation_requested ? 'cancelled' : 'completed',
        completed_at: completedAt,
      })
      .where('job_id', '=', jobId)
      .where('attempt_number', '=', owned.attempt_count)
      .where('worker_id', '=', workerId)
      .where('status', '=', 'running')
      .execute();
    await trx
      .updateTable('workers')
      .set({ running_jobs: sql`greatest(0, running_jobs - 1)` })
      .where('id', '=', workerId)
      .execute();
    return true;
  });
}

/** Retryable with attempts left: requeue after backoff; otherwise terminal failed. */
export async function failJob(
  db: Db,
  jobId: string,
  workerId: string,
  input: FailInput,
): Promise<{ requeued: boolean; persisted: boolean }> {
  return db.transaction().execute(async (trx) => {
    const job = await trx
      .selectFrom('jobs')
      .select(['attempt_count', 'max_attempts', 'cancellation_requested'])
      .where('id', '=', jobId)
      .where('lease_owner', '=', workerId)
      .where('status', 'in', ['leased', 'running'])
      .where('lease_expires_at', '>', sql<Date>`now()`)
      .forUpdate()
      .executeTakeFirst();
    if (!job) return { requeued: false, persisted: false };

    const retryable = input.retryable ?? isRetryableFailure(input.failureClass);
    const canRetry =
      !job.cancellation_requested && retryable && job.attempt_count < job.max_attempts;
    const lastError = { class: input.failureClass, message: input.message };
    const completedAt = new Date();

    if (canRetry) {
      const backoff = computeBackoffSeconds(
        job.attempt_count,
        input.backoff ?? backoffPolicyFor(input.failureClass),
      );
      await trx
        .updateTable('jobs')
        .set({
          status: 'queued',
          lease_owner: null,
          lease_expires_at: null,
          available_at: sql`now() + make_interval(secs => ${backoff})`,
          last_error: lastError,
        })
        .where('id', '=', jobId)
        .where('lease_owner', '=', workerId)
        .where('status', 'in', ['leased', 'running'])
        .execute();
      await trx
        .updateTable('job_attempts')
        .set({ status: 'retrying', error: lastError, completed_at: completedAt })
        .where('job_id', '=', jobId)
        .where('attempt_number', '=', job.attempt_count)
        .where('worker_id', '=', workerId)
        .where('status', '=', 'running')
        .execute();
      await trx
        .updateTable('workers')
        .set({ running_jobs: sql`greatest(0, running_jobs - 1)` })
        .where('id', '=', workerId)
        .execute();
      return { requeued: true, persisted: true };
    }

    const terminalStatus = job.cancellation_requested ? 'superseded' : 'failed';
    await trx
      .updateTable('jobs')
      .set({
        status: terminalStatus,
        completed_at: completedAt,
        lease_owner: null,
        lease_expires_at: null,
        last_error: lastError,
      })
      .where('id', '=', jobId)
      .where('lease_owner', '=', workerId)
      .where('status', 'in', ['leased', 'running'])
      .execute();
    await trx
      .updateTable('job_attempts')
      .set({
        status: job.cancellation_requested ? 'cancelled' : 'failed',
        error: lastError,
        completed_at: completedAt,
      })
      .where('job_id', '=', jobId)
      .where('attempt_number', '=', job.attempt_count)
      .where('worker_id', '=', workerId)
      .where('status', '=', 'running')
      .execute();
    await trx
      .updateTable('workers')
      .set({ running_jobs: sql`greatest(0, running_jobs - 1)` })
      .where('id', '=', workerId)
      .execute();
    return { requeued: false, persisted: true };
  });
}

/** Expired leases are requeued (the job reruns from scratch) or failed once attempts are exhausted. */
export async function sweepExpiredLeases(
  db: Db,
): Promise<{ requeued: number; failed: number; timedOut: SweptJob[] }> {
  return db.transaction().execute(async (trx) => {
    const res = await sql<{
      id: string;
      status: string;
      type: string;
      payload: Record<string, unknown>;
      attempt_count: number;
      previous_owner: string | null;
    }>`
      with expired as (
        select id, lease_owner
        from jobs
        where status in ('leased', 'running') and lease_expires_at < now()
        for update
      )
      update jobs as job
      set status = case
            when job.cancellation_requested then 'superseded'
            when job.attempt_count < job.max_attempts then 'queued'
            else 'failed'
          end,
          lease_owner = null,
          lease_expires_at = null,
          available_at = now(),
          completed_at = case when job.cancellation_requested or job.attempt_count >= job.max_attempts then now() else null end,
          last_error = case
            when job.cancellation_requested then jsonb_build_object('class', 'retryable_runner', 'message', 'cancelled job lease expired')
            else jsonb_build_object('class', 'retryable_runner', 'message', 'lease expired')
          end
      from expired
      where job.id = expired.id
      returning job.id, job.status, job.type, job.payload, job.attempt_count,
                expired.lease_owner as previous_owner
    `.execute(trx);

    const lastError = { class: 'retryable_runner', message: 'lease expired' };
    for (const row of res.rows) {
      await trx
        .updateTable('job_attempts')
        .set({
          status:
            row.status === 'queued'
              ? 'retrying'
              : row.status === 'superseded'
                ? 'cancelled'
                : 'failed',
          error: lastError,
          completed_at: new Date(),
        })
        .where('job_id', '=', row.id)
        .where('attempt_number', '=', row.attempt_count)
        .where('status', '=', 'running')
        .execute();
    }

    for (const workerId of new Set(
      res.rows.map((row) => row.previous_owner).filter((id): id is string => id !== null),
    )) {
      const active = await trx
        .selectFrom('jobs')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('lease_owner', '=', workerId)
        .where('status', 'in', ['leased', 'running'])
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('workers')
        .set({ running_jobs: Number(active.n) })
        .where('id', '=', workerId)
        .execute();
    }

    let requeued = 0;
    let failed = 0;
    const timedOut: SweptJob[] = [];
    for (const row of res.rows) {
      if (row.status === 'queued') requeued += 1;
      else if (row.status === 'failed') {
        failed += 1;
        timedOut.push({ id: row.id, type: row.type, payload: row.payload });
      }
    }
    return { requeued, failed, timedOut };
  });
}

/** Jobs the sweep failed terminally, so the supervisor can send typed timeout receipts. */
export interface SweptJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}
