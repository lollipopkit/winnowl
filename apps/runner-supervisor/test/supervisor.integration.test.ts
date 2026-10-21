import { exec as cpExec } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import type { RepositoryRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import {
  ensureRunnerPool,
  enqueueJob,
  isSafeToTerminate,
  registerWorker,
  setWorkerMode,
} from '@reviewbot/queue';
import { DockerSandboxBackend } from '@reviewbot/sandbox';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createSyncInstallationHandler } from '../src/sync-installation.js';
import { Supervisor, type JobHandler } from '../src/supervisor.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();

async function status(db: Db, jobId: string): Promise<string> {
  const row = await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow();
  return row.status;
}

const handlers = (sandboxUsing: JobHandler): Record<string, JobHandler> => ({
  index_repository: async () => undefined,
  security_scan: sandboxUsing,
  action_execute: async () => {
    throw new Error('boom');
  },
  sync_installation: createSyncInstallationHandler({
    resolveListRepositories: () => async (): Promise<RepositoryRef[]> => [
      { id: uuidv7(), providerHostId: HOST, installationId: INSTALL, nativeId: '900', namespace: 'acme', name: 'app', cloneUrl: 'x', defaultBranch: 'main' },
      { id: uuidv7(), providerHostId: HOST, installationId: INSTALL, nativeId: '901', namespace: 'acme', name: 'lib', cloneUrl: 'x', defaultBranch: 'main' },
    ],
  }),
});

/** Minimal rootfs that can run `echo`; unrelated to the logic under test. */
const SANDBOX_IMAGE = 'alpine:3.24';

describe('runner-supervisor', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let supervisor: Supervisor;
  let workerId: string;
  const sandbox = new DockerSandboxBackend();

  const runSandbox: JobHandler = async ({ sandbox: sb }) => {
    const h = await sb.create({ image: SANDBOX_IMAGE, network: { mode: 'none' }, resources: { cpus: 1, memoryMb: 128, pids: 32, diskMb: 32 }, maxLifetimeSeconds: 60 });
    try {
      const r = await sb.exec(h, { argv: ['echo', 'ok'], purpose: 'inspect', timeoutMs: 5000, maxOutputBytes: 1000 });
      if (r.stdout.trim() !== 'ok') throw new Error(`unexpected: ${r.stdout}`);
    } finally {
      await sb.destroy(h);
    }
  };

  beforeAll(async () => {
    // Pull only when missing locally: `docker pull` always authenticates (a keychain prompt on macOS),
    // while `docker image inspect` stays local.
    await new Promise<void>((r) =>
      cpExec(`docker image inspect ${SANDBOX_IMAGE} >/dev/null 2>&1 || docker pull ${SANDBOX_IMAGE}`, () => r()),
    );
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;

    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'https://github.com', api_url: 'https://api.github.com', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '999', account_login: 'acme', status: 'active', created_at: new Date() }).execute();

    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
    supervisor = new Supervisor({ db, sandbox, workerId, handlers: handlers(runSandbox) });
  });

  afterAll(async () => {
    await stop?.();
  });

  it('领取并完成普通 Job', async () => {
    const { jobId } = await enqueueJob(db, { tenantId: TENANT, type: 'index_repository', payload: {}, dedupeKey: 'j1' });
    expect(await supervisor.runOnce()).toBe(true);
    expect(await status(db, jobId)).toBe('completed');
  });

  it('Job 处理器可在 Sandbox 内执行命令(队列↔sandbox 打通)', async () => {
    const { jobId } = await enqueueJob(db, { tenantId: TENANT, type: 'security_scan', payload: {}, dedupeKey: 'j2' });
    await supervisor.runOnce();
    expect(await status(db, jobId)).toBe('completed');
  });

  it('处理器抛错 → Job 失败', async () => {
    const { jobId } = await enqueueJob(db, { tenantId: TENANT, type: 'action_execute', payload: {}, maxAttempts: 1, dedupeKey: 'j3' });
    await supervisor.runOnce();
    expect(await status(db, jobId)).toBe('failed');
  });

  it('sync_installation 处理器 upsert 仓库(M1 遗留打通)', async () => {
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'sync_installation',
      payload: { tenantId: TENANT, providerHostId: HOST, installationNativeId: '999', internalInstallationId: INSTALL },
      dedupeKey: 'j4',
    });
    await supervisor.runOnce();
    expect(await status(db, jobId)).toBe('completed');
    const count = await db.selectFrom('repositories').select((eb) => eb.fn.countAll<string>().as('n')).where('provider_host_id', '=', HOST).executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(2);
  });

  it('过期租约回收接线(§10.4 reaper;2026-07-18 live 缺陷回归):卡 running 的 job 被 sweep 重排队后可再领取', async () => {
    // Deploy-restart leftover: the job is stuck running with an expired lease.
    const { jobId } = await enqueueJob(db, { tenantId: TENANT, type: 'index_repository', payload: {}, dedupeKey: 'stuck-1' });
    await db
      .updateTable('jobs')
      .set({ status: 'running', lease_owner: workerId, lease_expires_at: new Date(Date.now() - 60_000), attempt_count: 1 })
      .where('id', '=', jobId)
      .execute();

    // Re-enqueueing with the same dedupeKey is absorbed by the stuck job.
    expect((await enqueueJob(db, { tenantId: TENANT, type: 'index_repository', payload: {}, dedupeKey: 'stuck-1' })).deduped).toBe(true);

    // The run loop's sweep requeues expired jobs, which then run normally.
    await supervisor.sweepIfDue();
    expect(await status(db, jobId)).toBe('queued');
    expect(await supervisor.runOnce()).toBe(true);
    expect(await status(db, jobId)).toBe('completed');

    // No second sweep within the interval (no-op, no throw).
    await supervisor.sweepIfDue();
  });

  /*
   * Shutdown arrives before the handler finishes but the handler returns normally: that is success,
   * so the job must not be requeued (which would repost comments and double-bill).
   */
  it('关停中正常返回的 handler 仍算完成,不被当成被打断而重排队', async () => {
    let handlerStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => (handlerStarted = resolve));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const local = new Supervisor({
      db,
      sandbox,
      workerId,
      handlers: {
        ...handlers(runSandbox),
        index_repository: async () => {
          handlerStarted();
          await gate;
        },
      },
    });

    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'index_repository',
      payload: {},
      dedupeKey: 'b3-shutdown',
      maxAttempts: 1,
    });
    const running = local.runOnce();
    await started;
    const aborted = local.abortInFlight(); // shutdown signal while the handler runs
    expect(aborted).toEqual([jobId]);
    release(); // the handler returns normally
    await running;

    expect(await status(db, jobId)).toBe('completed');
    expect(await db.selectFrom('jobs').select('attempt_count').where('id', '=', jobId).executeTakeFirstOrThrow()).toMatchObject({ attempt_count: 1 });
  });

  /*
   * The loop can also exit because the worker mode left active (draining / offline / row removed).
   * Worker heartbeats must continue while in-flight jobs finish: other runners sweep sandboxes of
   * workers missing for 90s (`listLiveWorkerIds`), and a review runs longer than that.
   */
  it('非 active 退出的收尾期间仍发 worker 心跳', async () => {
    await setWorkerMode(db, workerId, 'active');
    let handlerStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => (handlerStarted = resolve));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const local = new Supervisor({
      db,
      sandbox,
      workerId,
      heartbeatMs: 120,
      handlers: {
        ...handlers(runSandbox),
        index_repository: async () => {
          handlerStarted();
          await gate;
        },
      },
    });
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const heartbeatAt = async (): Promise<number> =>
      (
        await db
          .selectFrom('workers')
          .select('last_heartbeat_at')
          .where('id', '=', workerId)
          .executeTakeFirstOrThrow()
      ).last_heartbeat_at.getTime();

    await enqueueJob(db, { tenantId: TENANT, type: 'index_repository', payload: {}, dedupeKey: 'b4-drain' });
    const running = local.run(40);
    await started;
    await setWorkerMode(db, workerId, 'draining'); // the next loop iteration breaks and waits for in-flight jobs
    await sleep(300);
    const before = await heartbeatAt();
    await sleep(500);
    const after = await heartbeatAt();
    expect(after).toBeGreaterThan(before);

    release();
    await running;
    await setWorkerMode(db, workerId, 'active');
  });

  it('draining:不领取新 Job,可安全终止', async () => {
    await enqueueJob(db, { tenantId: TENANT, type: 'index_repository', payload: {}, dedupeKey: 'drain-1' });
    await setWorkerMode(db, workerId, 'draining');
    await supervisor.run(50); // exits at once on draining, claims nothing
    const row = await db.selectFrom('jobs').select('status').where('dedupe_key', '=', 'drain-1').executeTakeFirstOrThrow();
    expect(row.status).toBe('queued');
    expect(await isSafeToTerminate(db, workerId)).toBe(true);
  });
});
