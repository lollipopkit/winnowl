import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import {
  claimJob,
  completeJob,
  enqueueJob,
  ensureRunnerPool,
  registerWorker,
  releaseJobOnShutdown,
  startJob,
} from '@reviewbot/queue';
import { startMigratedPostgres } from '@reviewbot/testkit';

/*
 * Shutdown must not consume an attempt: `claimJob` increments attempt_count at claim time, so without
 * giving it back every deploy would cost an in-flight review an attempt.
 */
const TENANT = uuidv7();
describe('releaseJobOnShutdown —— 被自己的部署打断不算一次尝试', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let worker: string;
  let otherWorker: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'shutdown' });
    worker = await registerWorker(db, { poolId, version: 'test' });
    otherWorker = await registerWorker(db, { poolId, version: 'test' });
  });

  afterAll(async () => {
    await stop?.();
  });

  const enqueue = async (key: string): Promise<string> =>
    (
      await enqueueJob(db, {
        tenantId: TENANT,
        type: 'review_revision',
        payload: {},
        dedupeKey: key,
      })
    ).jobId;

  it('放回队列、还回尝试次数、立刻可领(它没有失败,只是被搬了个地方)', async () => {
    const jobId = await enqueue('rel-1');
    const claimed = await claimJob(db, {
      workerId: worker,
      leaseSeconds: 90,
      types: ['review_revision'],
    });
    expect(claimed?.attemptCount).toBe(1);
    await startJob(db, jobId, worker);
    // claimJob already created the job_attempts row (attempt_number = 1), left running.
    expect(
      await db.selectFrom('job_attempts').select('status').where('job_id', '=', jobId).execute(),
    ).toEqual([{ status: 'running' }]);

    expect(await releaseJobOnShutdown(db, jobId, worker)).toBe(true);

    const row = await db
      .selectFrom('jobs')
      .select(['status', 'attempt_count', 'lease_owner'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'queued', attempt_count: 0, lease_owner: null });
    // The row is deleted, not marked aborted: (job_id, attempt_number) is unique and the next claim reuses the number.
    expect(
      await db.selectFrom('job_attempts').select('status').where('job_id', '=', jobId).execute(),
    ).toEqual([]);

    // Claimable at once: backoff is for failures and this was not one.
    const again = await claimJob(db, {
      workerId: worker,
      leaseSeconds: 90,
      types: ['review_revision'],
    });
    expect(again?.id).toBe(jobId);
    expect(again?.attemptCount).toBe(1); // not 2
    expect(await completeJob(db, jobId, worker)).toBe(true);
  });

  it('不是自己握着的 job 一概不动 —— 并发下不能把别人的租约抢过来放回', async () => {
    const jobId = await enqueue('rel-2');
    await claimJob(db, { workerId: otherWorker, leaseSeconds: 90, types: ['review_revision'] });
    expect(await releaseJobOnShutdown(db, jobId, worker)).toBe(false);
    const row = await db
      .selectFrom('jobs')
      .select(['status', 'attempt_count'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'leased', attempt_count: 1 });
    expect(await completeJob(db, jobId, otherWorker)).toBe(true);
  });

  it('已经请求取消的在途 job 在关停释放时直接终态,不会重新排队', async () => {
    const jobId = await enqueue('rel-cancelled');
    await claimJob(db, { workerId: worker, leaseSeconds: 90, types: ['review_revision'] });
    await startJob(db, jobId, worker);
    await db
      .updateTable('jobs')
      .set({ cancellation_requested: true })
      .where('id', '=', jobId)
      .execute();

    expect(await releaseJobOnShutdown(db, jobId, worker)).toBe(true);
    expect(
      await db
        .selectFrom('jobs')
        .select(['status', 'cancellation_requested'])
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ status: 'superseded', cancellation_requested: true });
    expect(
      await db.selectFrom('job_attempts').select('status').where('job_id', '=', jobId).execute(),
    ).toEqual([{ status: 'cancelled' }]);
    expect(
      await claimJob(db, { workerId: otherWorker, leaseSeconds: 90, types: ['review_revision'] }),
    ).toBeNull();
  });
});
