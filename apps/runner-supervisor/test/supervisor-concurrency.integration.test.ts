import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { ensureRunnerPool, enqueueJob, registerWorker, type Job } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { Supervisor } from '../src/supervisor.js';

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

describe('Supervisor 并发消费(RUNNER_CONCURRENCY,2026-07-21)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let workerId: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, {
      poolId,
      version: '1.0.0',
      capabilities: {},
      maxConcurrency: 4,
    });
  });

  afterAll(async () => {
    await stop?.();
  });

  it('concurrency=2:慢 Job 在途时快 Job 并行完成;退出前等在途 Job 收尾', async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    let slowStarted = false;
    let slowDone = false;
    let fastDone = false;

    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      lanes: [{ name: 'default', concurrency: 2 }],
      handlers: {
        slow_job: async () => {
          slowStarted = true;
          await slowGate;
          slowDone = true;
        },
        fast_job: async () => {
          fastDone = true;
        },
      },
    });

    // The slow job is enqueued first and blocks; serially, the fast job would wait for it.
    await enqueueJob(db, { tenantId: TENANT, type: 'slow_job', payload: {}, dedupeKey: 'slow-1' });
    await enqueueJob(db, { tenantId: TENANT, type: 'fast_job', payload: {}, dedupeKey: 'fast-1' });

    const running = supervisor.run(20);
    // The fast job finishing while the slow one blocks proves concurrency.
    const deadline = Date.now() + 5_000;
    while (!fastDone && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(slowStarted).toBe(true);
    expect(fastDone).toBe(true); // the fast job finished while the slow one was still running
    expect(slowDone).toBe(false);

    // After requestStop, run() returns only once the in-flight slow job finishes (draining).
    supervisor.requestStop();
    releaseSlow();
    await running;
    expect(slowDone).toBe(true);

    const statuses = await db
      .selectFrom('jobs')
      .select(['type', 'status'])
      .where('tenant_id', '=', TENANT)
      .execute();
    expect(
      statuses
        .filter((j) => j.status === 'completed')
        .map((j) => j.type)
        .sort(),
    ).toEqual(['fast_job', 'slow_job']);
  });

  it('requestStop 发生在 claim 等待期间时,返回的 Job 被释放且不启动 handler', async () => {
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'claim_race_job',
      payload: {},
      dedupeKey: `claim-race-${uuidv7()}`,
    });
    let handled = false;
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: {
        claim_race_job: async () => {
          handled = true;
        },
      },
    });
    const internal = supervisor as unknown as {
      claimNext(filter?: { types?: string[]; excludeTypes?: string[] }): Promise<Job | null>;
    };
    const originalClaim = internal.claimNext.bind(supervisor);
    let releaseClaim!: () => void;
    let claimStarted!: () => void;
    const claimGate = new Promise<void>((resolve) => (releaseClaim = resolve));
    const started = new Promise<void>((resolve) => (claimStarted = resolve));
    internal.claimNext = async (filter) => {
      claimStarted();
      await claimGate;
      return originalClaim(filter);
    };

    const running = supervisor.run(10);
    await started;
    supervisor.requestStop();
    releaseClaim();
    await running;

    expect(handled).toBe(false);
    expect(
      await db
        .selectFrom('jobs')
        .select(['status', 'lease_owner', 'attempt_count'])
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'queued', lease_owner: null, attempt_count: 0 });
  });

  // Commands like "stop" are sent exactly when all slots are busy, so they need their own lane.
  it('主 lane 被长任务占满时,控制面命令仍立刻执行(短任务独立 lane)', async () => {
    let releaseLong!: () => void;
    const longGate = new Promise<void>((r) => (releaseLong = r));
    let longStarted = 0;
    let commandDone = false;

    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      lanes: [
        { name: 'main', concurrency: 1 }, // the only main slot is held by a long job
        { name: 'command', types: ['conversation_turn'], concurrency: 1 },
      ],
      handlers: {
        long_job: async () => {
          longStarted += 1;
          await longGate;
        },
        conversation_turn: async () => {
          commandDone = true;
        },
      },
    });

    await enqueueJob(db, { tenantId: TENANT, type: 'long_job', payload: {}, dedupeKey: 'long-1' });
    const running = supervisor.run(20);
    const deadline = Date.now() + 5_000;
    while (longStarted === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(longStarted).toBe(1);

    // The command is enqueued after the main lane is full; with one lane it would wait for the long job.
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {},
      dedupeKey: 'cmd-1',
    });
    const cmdDeadline = Date.now() + 5_000;
    while (!commandDone && Date.now() < cmdDeadline) await new Promise((r) => setTimeout(r, 10));
    expect(commandDone).toBe(true);

    supervisor.requestStop();
    releaseLong();
    await running;
  });

  it('短 lane 占着命令时,主 lane 照常领别的 job(两条 lane 各算各的槽位)', async () => {
    let releaseLong!: () => void;
    let releaseCmd!: () => void;
    const longGate = new Promise<void>((r) => (releaseLong = r));
    const cmdGate = new Promise<void>((r) => (releaseCmd = r));
    let cmdStarted = 0;
    let longDone = false;
    let otherDone = false;

    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      lanes: [
        { name: 'main', concurrency: 1 },
        { name: 'command', types: ['conversation_turn'], concurrency: 1 },
      ],
      handlers: {
        long_job: async () => {
          await longGate;
          longDone = true;
        },
        conversation_turn: async () => {
          cmdStarted += 1;
          await cmdGate;
        },
        other_job: async () => {
          otherDone = true;
        },
      },
    });

    // The main lane is busy first, so the command lands on the short lane (it may also use an idle main lane).
    await enqueueJob(db, { tenantId: TENANT, type: 'long_job', payload: {}, dedupeKey: 'long-2' });
    const running = supervisor.run(20);
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {},
      dedupeKey: 'cmd-2',
    });
    const deadline = Date.now() + 5_000;
    while (cmdStarted === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(cmdStarted).toBe(1);

    // With the command on the short lane, the freed main slot takes the next long job.
    releaseLong();
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'other_job',
      payload: {},
      dedupeKey: 'other-1',
    });
    const otherDeadline = Date.now() + 5_000;
    while (!otherDone && Date.now() < otherDeadline) await new Promise((r) => setTimeout(r, 10));
    expect(otherDone).toBe(true);
    expect(longDone).toBe(true);
    expect(cmdStarted).toBe(1); // the short-lane command is not claimed twice

    supervisor.requestStop();
    releaseCmd();
    await running;
  });

  // The background lane excludes sandbox/command types, so short jobs do not wait behind a review.
  it('a long sandbox job does not block background jobs; background never claims sandbox/command types', async () => {
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((r) => (releaseReview = r));
    const started: string[] = [];
    let backgroundDone = false;

    const sandboxTypes = ['review_revision', 'action_execute'];
    const commandTypes = ['conversation_turn'];
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      lanes: [
        { name: 'sandbox', types: sandboxTypes, concurrency: 1 },
        // A dedicated command lane is left out on purpose: queued commands must stay queued
        // instead of leaking into the background lane.
        { name: 'background', excludeTypes: [...sandboxTypes, ...commandTypes], concurrency: 2 },
      ],
      handlers: {
        review_revision: async () => {
          started.push('review_revision');
          await reviewGate;
        },
        action_execute: async () => {
          started.push('action_execute');
        },
        conversation_turn: async () => {
          started.push('conversation_turn');
        },
        webhook_redeliver: async () => {
          started.push('webhook_redeliver');
          backgroundDone = true;
        },
      },
    });

    const review = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {},
      dedupeKey: `lane-review-${uuidv7()}`,
    });
    const running = supervisor.run(20);
    const deadline = Date.now() + 5_000;
    while (started.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(['review_revision']);

    // The sandbox lane is full. Queue a second sandbox job and a command (neither may run now)
    // and a background job (must run despite the long review).
    const fix = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: {},
      dedupeKey: `lane-fix-${uuidv7()}`,
    });
    const cmd = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {},
      dedupeKey: `lane-cmd-${uuidv7()}`,
    });
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'webhook_redeliver',
      payload: {},
      dedupeKey: `lane-bg-${uuidv7()}`,
    });
    const bgDeadline = Date.now() + 5_000;
    while (!backgroundDone && Date.now() < bgDeadline) await new Promise((r) => setTimeout(r, 10));
    expect(backgroundDone).toBe(true);
    // Give the background lane (one free slot left) a few more poll loops to misbehave.
    await new Promise((r) => setTimeout(r, 200));
    expect(started).toEqual(['review_revision', 'webhook_redeliver']);

    supervisor.requestStop();
    releaseReview();
    await running;

    const rows = await db
      .selectFrom('jobs')
      .select(['id', 'status'])
      .where('id', 'in', [review.jobId, fix.jobId, cmd.jobId])
      .execute();
    const status = new Map(rows.map((r) => [r.id, r.status]));
    expect(status.get(review.jobId)).toBe('completed');
    expect(status.get(fix.jobId)).toBe('queued');
    expect(status.get(cmd.jobId)).toBe('queued');
    // Leave nothing claimable behind for later tests sharing this worker.
    await db
      .updateTable('jobs')
      .set({ status: 'cancelled' })
      .where('id', 'in', [fix.jobId, cmd.jobId])
      .execute();
  });

  it('worker 心跳持续刷新注册表', async () => {
    await db
      .updateTable('workers')
      .set({ last_heartbeat_at: new Date(0) })
      .where('id', '=', workerId)
      .execute();
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      heartbeatMs: 10,
      handlers: {},
    });
    const running = supervisor.run(5);
    const deadline = Date.now() + 2_000;
    let heartbeat = 0;
    while (heartbeat === 0 && Date.now() < deadline) {
      heartbeat = new Date(
        (
          await db
            .selectFrom('workers')
            .select('last_heartbeat_at')
            .where('id', '=', workerId)
            .executeTakeFirstOrThrow()
        ).last_heartbeat_at,
      ).getTime();
      if (heartbeat === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    supervisor.requestStop();
    await running;
    expect(heartbeat).toBeGreaterThan(0);
  });

  it('租约续期失败会向 handler 发取消信号且不会改写新 owner 的租约', async () => {
    let started = false;
    let aborted = false;
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      heartbeatMs: 10,
      handlers: {
        lease_guard: async ({ signal }) => {
          started = true;
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          );
        },
      },
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'lease_guard',
      payload: {},
      dedupeKey: `lease-guard-${uuidv7()}`,
    });
    const running = supervisor.runOnce();
    const deadline = Date.now() + 2_000;
    while (!started && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const newOwner = uuidv7();
    await db.updateTable('jobs').set({ lease_owner: newOwner }).where('id', '=', jobId).execute();
    await running;
    expect(aborted).toBe(true);
    const row = await db
      .selectFrom('jobs')
      .select(['status', 'lease_owner'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'running', lease_owner: newOwner });
  });

  it('关停先取消并等待 handler,再安全释放快照中的租约', async () => {
    let started = false;
    let stopped = false;
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: {
        // A handler cut short must throw (a normal return is recorded as completed).
        shutdown_guard: async ({ signal }) => {
          started = true;
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                stopped = true;
                reject(new Error('work was cut short by shutdown'));
              },
              { once: true },
            ),
          );
        },
      },
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'shutdown_guard',
      payload: {},
      dedupeKey: `shutdown-guard-${uuidv7()}`,
    });
    const running = supervisor.run(5);
    const deadline = Date.now() + 2_000;
    while (!started && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    supervisor.requestStop();
    const ids = supervisor.abortInFlight();
    await running;
    expect(stopped).toBe(true);
    expect(ids).toContain(jobId);
    expect(await supervisor.releaseInFlight(ids)).toBe(1);
    const row = await db
      .selectFrom('jobs')
      .select(['status', 'attempt_count'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'queued', attempt_count: 0 });
  });
});
