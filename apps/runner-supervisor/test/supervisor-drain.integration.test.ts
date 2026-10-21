import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import {
  enqueueJob,
  ensureRunnerPool,
  heartbeatWorker,
  registerWorker,
  setWorkerMode,
} from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createShutdown } from '../src/shutdown.js';
import { JobExecutionError, Supervisor } from '../src/supervisor.js';

/*
 * Graceful drain against a real queue: no new claims, the in-flight lease keeps renewing past its
 * original expiry, and the job ends with its own outcome instead of being released to the queue.
 */
const TENANT = uuidv7();

const noopSandbox: SandboxBackend = {
  create: async () => ({ id: 's', containerId: 'c' }),
  exec: async () => {
    throw new Error('unused');
  },
  putFile: async () => undefined,
  getArtifact: async () => ({ path: '', content: '', bytes: 0 }),
  destroy: async () => undefined,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const silent = { info: () => undefined, warn: () => undefined };

describe('runner drain on shutdown', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let poolId: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'drain' });
  });

  afterAll(async () => {
    await stop?.();
  });

  // Each test uses its own job type so a job left queued by one test is not claimed by the next.
  function build(workerId: string, type: string, handler: (signal: AbortSignal) => Promise<void>) {
    let started = false;
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      leaseSeconds: 1,
      heartbeatMs: 200,
      handlers: {
        [type]: async ({ signal }) => {
          started = true;
          await handler(signal);
        },
      },
    });
    const running = supervisor.run(20);
    const shutdown = createShutdown({
      drainTimeoutMs: 30_000,
      stopClaiming: async () => {
        await setWorkerMode(db, workerId, 'draining');
        supervisor.requestStop();
      },
      idle: running,
      inFlightJobs: () => supervisor.inFlightJobs(),
      heartbeat: () => heartbeatWorker(db, workerId),
      abortInFlight: () => supervisor.abortInFlight(),
      destroySandboxes: async () => 0,
      release: (ids) => supervisor.releaseInFlight(ids),
      log: silent,
      abortGraceMs: 2_000,
    });
    const waitStarted = async (): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!started && Date.now() < deadline) await sleep(10);
      expect(started).toBe(true);
    };
    return { supervisor, shutdown, waitStarted };
  }

  const jobRow = (id: string) =>
    db
      .selectFrom('jobs')
      .select(['status', 'attempt_count', 'lease_owner', 'lease_expires_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('keeps renewing the lease, claims nothing new, and lets the job complete', async () => {
    const workerId = await registerWorker(db, { poolId, version: 'test', maxConcurrency: 2 });
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const t = build(workerId, 'drain_complete', () => gate);
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'drain_complete',
      payload: {},
      dedupeKey: `drain-${uuidv7()}`,
    });
    await t.waitStarted();

    const outcome = t.shutdown.request('SIGTERM');
    const { jobId: queuedId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'drain_complete',
      payload: {},
      dedupeKey: `drain-${uuidv7()}`,
    });
    // Three lease periods: without renewal the 1s lease would have expired.
    await sleep(3_000);
    const mid = await jobRow(jobId);
    expect(mid).toMatchObject({ status: 'running', lease_owner: workerId });
    expect(new Date(mid.lease_expires_at as unknown as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(t.supervisor.inFlightJobs()).toEqual([{ id: jobId, type: 'drain_complete' }]);
    expect((await jobRow(queuedId)).status).toBe('queued');

    finish();
    await expect(outcome).resolves.toEqual({ kind: 'drained' });
    expect((await jobRow(jobId)).status).toBe('completed');
    expect((await jobRow(queuedId)).status).toBe('queued');
  });

  it('a job that fails during the drain still persists its failure', async () => {
    const workerId = await registerWorker(db, { poolId, version: 'test' });
    let fail!: () => void;
    const gate = new Promise<void>((r) => (fail = r));
    const t = build(workerId, 'drain_fail', async () => {
      await gate;
      throw new JobExecutionError('boom', 'internal_bug', false);
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'drain_fail',
      payload: {},
      dedupeKey: `drain-fail-${uuidv7()}`,
    });
    await t.waitStarted();
    const outcome = t.shutdown.request('SIGTERM');
    await sleep(100);
    fail();
    await expect(outcome).resolves.toEqual({ kind: 'drained' });
    const row = await jobRow(jobId);
    expect(row.status).not.toBe('running');
    expect(row.lease_owner).toBeNull();
  });

  // Returning normally means done (completed, not re-run), so a handler cut short must throw.
  it('a second signal aborts the job and releases it without counting the attempt', async () => {
    const workerId = await registerWorker(db, { poolId, version: 'test' });
    const t = build(
      workerId,
      'drain_force',
      (signal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new JobExecutionError('work was cut short by shutdown', 'retryable_runner', true)),
            { once: true },
          ),
        ),
    );
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'drain_force',
      payload: {},
      dedupeKey: `drain-force-${uuidv7()}`,
    });
    await t.waitStarted();
    const outcome = t.shutdown.request('SIGTERM');
    await sleep(300);
    expect((await jobRow(jobId)).status).toBe('running');
    void t.shutdown.request('SIGTERM');
    await expect(outcome).resolves.toEqual({ kind: 'released', released: 1, jobs: 1 });
    expect(await jobRow(jobId)).toMatchObject({ status: 'queued', attempt_count: 0 });
  });

  // A failing loop iteration (e.g. postgres restarting) is retried; run() must not reject.
  it('survives database errors in the run loop: in-flight jobs finish, claiming resumes', async () => {
    const workerId = await registerWorker(db, { poolId, version: 'test', maxConcurrency: 2 });
    let failing = 0;
    // Every query the loop starts fails while `failing` > 0 (what a postgres restart looks like).
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (failing > 0 && (prop === 'selectFrom' || prop === 'updateTable' || prop === 'transaction')) {
          failing -= 1;
          return () => {
            throw new Error('Connection terminated unexpectedly');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Db;
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const handled: string[] = [];
    const supervisor = new Supervisor({
      db: flaky,
      sandbox: noopSandbox,
      workerId,
      leaseSeconds: 5,
      heartbeatMs: 200,
      handlers: {
        db_blip: async ({ job }) => {
          handled.push(job.id);
          if (handled.length === 1) await gate;
        },
      },
    });
    let settled = false;
    const running = supervisor.run(20).finally(() => (settled = true));
    const { jobId: first } = await enqueueJob(db, { tenantId: TENANT, type: 'db_blip', payload: {}, dedupeKey: `blip-${uuidv7()}` });
    const deadline = Date.now() + 5_000;
    while (handled.length === 0 && Date.now() < deadline) await sleep(10);
    expect(handled).toEqual([first]);

    failing = 5; // the database goes away for a few iterations
    await sleep(500);
    expect(settled).toBe(false); // the loop is still alive

    finish();
    const { jobId: second } = await enqueueJob(db, { tenantId: TENANT, type: 'db_blip', payload: {}, dedupeKey: `blip-${uuidv7()}` });
    const until = Date.now() + 5_000;
    while (handled.length < 2 && Date.now() < until) await sleep(20);
    expect(handled).toEqual([first, second]);
    expect((await jobRow(first)).status).toBe('completed');

    supervisor.requestStop();
    await running;
  });
});
