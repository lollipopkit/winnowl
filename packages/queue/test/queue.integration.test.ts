import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  claimJob,
  completeJob,
  ensureRunnerPool,
  enqueueJob,
  failJob,
  heartbeatJob,
  isSafeToTerminate,
  registerWorker,
  reviewDedupeKey,
  setJobTraceCarrierProvider,
  setWorkerMode,
  startJob,
  cancelReviewJobsForChangeRequest,
  supersedeOlderReviewJobs,
  sweepExpiredLeases,
} from '../src/index.js';

const TENANT = uuidv7();
const OTHER_TENANT = uuidv7();

async function status(db: Db, jobId: string): Promise<string> {
  const row = await db
    .selectFrom('jobs')
    .select('status')
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow();
  return row.status;
}

// Each test uses a unique selector so claims do not cross tests.
function sel(name: string): Record<string, unknown> {
  return { job: name };
}

describe('queue', () => {
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
    await db
      .insertInto('tenants')
      .values({ id: OTHER_TENANT, name: 'other', region: null, created_at: new Date() })
      .execute();
    poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'test-workers' });
  });

  afterAll(async () => {
    await stop?.();
  });

  const worker = (capabilities: Record<string, unknown> = {}, maxConcurrency = 50) =>
    registerWorker(db, { poolId, version: 'test', capabilities, maxConcurrency });

  it('入队幂等:同 dedupe_key 返回既有 Job', async () => {
    const a = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: { x: 1 },
      dedupeKey: 'k1',
      runnerSelector: sel('k1'),
    });
    const b = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: { x: 2 },
      dedupeKey: 'k1',
      runnerSelector: sel('k1'),
    });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.jobId).toBe(a.jobId);
  });

  it('§41 trace 载体:注入 provider → 入队落 trace_context → claim 回传 traceCarrier', async () => {
    setJobTraceCarrierProvider(() => ({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    }));
    try {
      await enqueueJob(db, {
        tenantId: TENANT,
        type: 'review_revision',
        payload: {},
        dedupeKey: 'trace-1',
        runnerSelector: sel('trace-1'),
      });
      const claimed = await claimJob(db, {
        workerId: await worker(sel('trace-1')),
        leaseSeconds: 90,
      });
      expect(claimed?.traceCarrier?.traceparent).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
    } finally {
      setJobTraceCarrierProvider(undefined);
    }
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {},
      dedupeKey: 'trace-2',
      runnerSelector: sel('trace-2'),
    });
    const plain = await claimJob(db, {
      workerId: await worker(sel('trace-2')),
      leaseSeconds: 90,
    });
    expect(plain?.traceCarrier).toBeUndefined();
  });

  it('SKIP LOCKED:并发 claim 同一 Job 只有一个成功', async () => {
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'index_repository',
      payload: {},
      dedupeKey: 'concurrent',
      runnerSelector: sel('concurrent'),
    });
    const [w1, w2] = await Promise.all([worker(sel('concurrent')), worker(sel('concurrent'))]);
    const [c1, c2] = await Promise.all([
      claimJob(db, { workerId: w1, leaseSeconds: 90 }),
      claimJob(db, { workerId: w2, leaseSeconds: 90 }),
    ]);
    const claimed = [c1, c2].filter((c) => c !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.dedupeKey).toBe('concurrent');
  });

  it('tenant runner pool 只能领取本租户 Job;共享池仍可跨租户服务', async () => {
    const selector = sel(`tenant-pool-${uuidv7()}`);
    const { jobId } = await enqueueJob(db, {
      tenantId: OTHER_TENANT,
      type: 'index_repository',
      payload: {},
      runnerSelector: selector,
    });
    expect(
      await claimJob(db, {
        workerId: await worker(selector),
        leaseSeconds: 90,
      }),
    ).toBeNull();

    const sharedPool = await ensureRunnerPool(db, { name: `shared-${uuidv7()}` });
    const sharedWorker = await registerWorker(db, {
      poolId: sharedPool,
      version: 'test',
      capabilities: selector,
    });
    expect((await claimJob(db, { workerId: sharedWorker, leaseSeconds: 90 }))?.id).toBe(jobId);
  });

  it('worker maxConcurrency 是 claim 的原子上限并维护 running_jobs', async () => {
    const selector = sel(`capacity-${uuidv7()}`);
    const w = await worker(selector, 1);
    const first = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'index_repository',
      payload: {},
      runnerSelector: selector,
    });
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'index_repository',
      payload: {},
      runnerSelector: selector,
    });
    expect((await claimJob(db, { workerId: w, leaseSeconds: 90 }))?.id).toBe(first.jobId);
    expect(await claimJob(db, { workerId: w, leaseSeconds: 90 })).toBeNull();
    expect(
      (
        await db
          .selectFrom('workers')
          .select('running_jobs')
          .where('id', '=', w)
          .executeTakeFirstOrThrow()
      ).running_jobs,
    ).toBe(1);
    expect(await completeJob(db, first.jobId, w)).toBe(true);
    expect(await claimJob(db, { workerId: w, leaseSeconds: 90 })).not.toBeNull();
  });

  it('selector 匹配:capabilities 必须包含 runner_selector', async () => {
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'security_scan',
      payload: {},
      dedupeKey: 'sel',
      runnerSelector: { os: 'linux', k: 'sel' },
    });
    const miss = await claimJob(db, {
      workerId: await worker({ os: 'linux' }),
      leaseSeconds: 90,
    });
    expect(miss).toBeNull();
    const hit = await claimJob(db, {
      workerId: await worker({ os: 'linux', k: 'sel', arch: 'x64' }),
      leaseSeconds: 90,
    });
    expect(hit?.dedupeKey).toBe('sel');
    expect(
      await claimJob(db, {
        workerId: uuidv7(),
        leaseSeconds: 90,
      }),
    ).toBeNull();
  });

  // Empty filter arrays mean "no restriction": `any('{}')` is always false and would starve the lane.
  it('types 过滤:只领指定类型;空数组 = 不限', async () => {
    const caps = sel('types');
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {},
      dedupeKey: 'types-long',
      runnerSelector: caps,
    });
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {},
      dedupeKey: 'types-cmd',
      runnerSelector: caps,
    });

    const w = await worker(caps);
    const cmd = await claimJob(db, {
      workerId: w,
      capabilities: caps,
      leaseSeconds: 90,
      types: ['conversation_turn'],
    });
    expect(cmd?.dedupeKey).toBe('types-cmd');
    const none = await claimJob(db, {
      workerId: w,
      capabilities: caps,
      leaseSeconds: 90,
      types: ['post_merge_action'],
    });
    expect(none).toBeNull();
    const any = await claimJob(db, {
      workerId: w,
      capabilities: caps,
      leaseSeconds: 90,
      types: [],
    });
    expect(any?.dedupeKey).toBe('types-long');
  });

  it('excludeTypes filter: skips excluded types; empty array = no restriction', async () => {
    const caps = sel('exclude-types');
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {},
      dedupeKey: 'exclude-review',
      runnerSelector: caps,
    });
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {},
      dedupeKey: 'exclude-cmd',
      runnerSelector: caps,
    });
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'webhook_redeliver',
      payload: {},
      dedupeKey: 'exclude-bg',
      runnerSelector: caps,
    });

    // The head of the queue is the review; the background lane only sees the last job.
    const w = await worker(caps);
    const background = {
      workerId: w,
      leaseSeconds: 90,
      excludeTypes: ['review_revision', 'conversation_turn'],
    };
    expect((await claimJob(db, background))?.dedupeKey).toBe('exclude-bg');
    expect(await claimJob(db, background)).toBeNull();
    // Combined with `types`: both filters apply.
    expect(
      await claimJob(db, {
        workerId: w,
        leaseSeconds: 90,
        types: ['conversation_turn'],
        excludeTypes: ['conversation_turn'],
      }),
    ).toBeNull();
    const any = await claimJob(db, { workerId: w, leaseSeconds: 90, excludeTypes: [] });
    expect(any?.dedupeKey).toBe('exclude-review');
  });

  it('租约过期 sweep 后重排队,整任务重跑', async () => {
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'pipeline_analyze',
      payload: {},
      dedupeKey: 'lease',
      runnerSelector: sel('lease'),
    });
    const claimed = await claimJob(db, {
      workerId: await worker(sel('lease')),
      leaseSeconds: -1,
    });
    expect(claimed?.id).toBe(jobId);
    const swept = await sweepExpiredLeases(db);
    expect(swept.requeued).toBeGreaterThanOrEqual(1);
    expect(await status(db, jobId)).toBe('queued');
    expect(
      await db.selectFrom('job_attempts').select('status').where('job_id', '=', jobId).execute(),
    ).toEqual([{ status: 'retrying' }]);
  });

  it('租约过期后旧 owner 不能启动、续租、完成或失败', async () => {
    const selector = sel(`expired-owner-${uuidv7()}`);
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'pipeline_analyze',
      payload: {},
      runnerSelector: selector,
    });
    const w = await worker(selector);
    await claimJob(db, { workerId: w, leaseSeconds: -1 });
    expect(await startJob(db, jobId, w)).toBe(false);
    expect(await heartbeatJob(db, jobId, w, 90)).toBe(false);
    expect(await completeJob(db, jobId, w)).toBe(false);
    expect(
      await failJob(db, jobId, w, { failureClass: 'retryable_runner', message: 'late' }),
    ).toEqual({ requeued: false, persisted: false });
  });

  it('已取消 Job 的过期租约由 sweep 收口为 superseded,不会复活排队', async () => {
    const selector = sel(`cancelled-expiry-${uuidv7()}`);
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {},
      runnerSelector: selector,
    });
    const w = await worker(selector);
    await claimJob(db, { workerId: w, leaseSeconds: -1 });
    await db
      .updateTable('jobs')
      .set({ cancellation_requested: true })
      .where('id', '=', jobId)
      .execute();
    const swept = await sweepExpiredLeases(db);
    expect(await status(db, jobId)).toBe('superseded');
    expect(swept.failed).toBe(0);
    expect(swept.timedOut.some((job) => job.id === jobId)).toBe(false);
  });

  it('cancellation_requested 的 queued job 不可领取,retryable failure 也终态为 superseded', async () => {
    const queuedSelector = sel(`cancelled-queued-${uuidv7()}`);
    const { jobId: queuedId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {},
      runnerSelector: queuedSelector,
    });
    await db
      .updateTable('jobs')
      .set({ cancellation_requested: true })
      .where('id', '=', queuedId)
      .execute();
    expect(
      await claimJob(db, { workerId: await worker(queuedSelector), leaseSeconds: 90 }),
    ).toBeNull();

    const runningSelector = sel(`cancelled-running-${uuidv7()}`);
    const { jobId: runningId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {},
      runnerSelector: runningSelector,
    });
    const owner = await worker(runningSelector);
    await claimJob(db, { workerId: owner, leaseSeconds: 90 });
    await db
      .updateTable('jobs')
      .set({ cancellation_requested: true })
      .where('id', '=', runningId)
      .execute();
    expect(
      await failJob(db, runningId, owner, {
        failureClass: 'retryable_runner',
        message: 'cancelled during failure',
      }),
    ).toEqual({ requeued: false, persisted: true });
    expect(await status(db, runningId)).toBe('superseded');
  });

  it('complete acknowledgement preserves a concurrent cancellation as superseded', async () => {
    const selector = sel(`cancelled-complete-${uuidv7()}`);
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {},
      runnerSelector: selector,
    });
    const owner = await worker(selector);
    await claimJob(db, { workerId: owner, leaseSeconds: 90 });
    await db
      .updateTable('jobs')
      .set({ cancellation_requested: true })
      .where('id', '=', jobId)
      .execute();
    expect(await completeJob(db, jobId, owner)).toBe(true);
    expect(await status(db, jobId)).toBe('superseded');
  });

  it('complete 后不可再领取', async () => {
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'issue_enrich',
      payload: {},
      dedupeKey: 'done',
      runnerSelector: sel('done'),
    });
    const w = await worker(sel('done'));
    const claimed = await claimJob(db, {
      workerId: w,
      leaseSeconds: 90,
    });
    expect(claimed?.id).toBe(jobId);
    expect(await completeJob(db, jobId, w)).toBe(true);
    expect(await status(db, jobId)).toBe('completed');
    const again = await claimJob(db, {
      workerId: await worker(sel('done')),
      leaseSeconds: 90,
    });
    expect(again).toBeNull();
  });

  it('可重试失败 → 退避重排队', async () => {
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: {},
      dedupeKey: 'retry',
      maxAttempts: 3,
      runnerSelector: sel('retry'),
    });
    const w = await worker(sel('retry'));
    await claimJob(db, { workerId: w, leaseSeconds: 90 });
    const r = await failJob(db, jobId, w, { failureClass: 'retryable_runner', message: 'flaky' });
    expect(r.requeued).toBe(true);
    expect(r.persisted).toBe(true);
    expect(await status(db, jobId)).toBe('queued');
  });

  it('超次数失败 → 终态 failed', async () => {
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: {},
      dedupeKey: 'terminal',
      maxAttempts: 1,
      runnerSelector: sel('terminal'),
    });
    const w = await worker(sel('terminal'));
    await claimJob(db, { workerId: w, leaseSeconds: 90 });
    const r = await failJob(db, jobId, w, { failureClass: 'retryable_runner', message: 'boom' });
    expect(r.requeued).toBe(false);
    expect(r.persisted).toBe(true);
    expect(await status(db, jobId)).toBe('failed');
  });

  it('不可重试失败 → 直接 failed', async () => {
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: {},
      dedupeKey: 'policy',
      maxAttempts: 3,
      runnerSelector: sel('policy'),
    });
    const w = await worker(sel('policy'));
    await claimJob(db, { workerId: w, leaseSeconds: 90 });
    const r = await failJob(db, jobId, w, { failureClass: 'policy_denied', message: 'nope' });
    expect(r.requeued).toBe(false);
    expect(r.persisted).toBe(true);
    expect(await status(db, jobId)).toBe('failed');
  });

  it('draining worker 不领新 Job 且可安全终止判定', async () => {
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool-1' });
    const w = await registerWorker(db, { poolId, version: '1.0.0' });
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'index_repository',
      payload: {},
      dedupeKey: 'drain',
      runnerSelector: sel('drain'),
    });
    await setWorkerMode(db, w, 'draining');
    const claimed = await claimJob(db, {
      workerId: w,
      leaseSeconds: 90,
    });
    expect(claimed).toBeNull();
    expect(await isSafeToTerminate(db, w)).toBe(true);
  });

  it('新 Head supersede 旧 review Job', async () => {
    const repo = uuidv7();
    const cr = uuidv7();
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: { changeRequestId: cr, headSha: 'old' },
      dedupeKey: reviewDedupeKey({
        repositoryId: repo,
        changeRequestId: cr,
        headSha: 'old',
        configDigest: 'c',
      }),
      runnerSelector: sel('supersede'),
    });
    await enqueueJob(db, {
      tenantId: OTHER_TENANT,
      type: 'review_revision',
      payload: { changeRequestId: cr, headSha: 'old' },
      dedupeKey: `other-${cr}`,
    });
    const superseded = await supersedeOlderReviewJobs(db, {
      tenantId: TENANT,
      changeRequestId: cr,
      headSha: 'new',
    });
    expect(superseded).toBe(1);
    expect(
      await db
        .selectFrom('jobs')
        .select('status')
        .where('tenant_id', '=', OTHER_TENANT)
        .where('dedupe_key', '=', `other-${cr}`)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ status: 'queued' });
  });

  it('CR 关闭/合并 → 取消该 CR 全部在途 review Job(不分 Head)', async () => {
    const repo = uuidv7();
    const cr = uuidv7();
    const other = uuidv7();
    const { jobId: mine } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: { changeRequestId: cr, headSha: 'h1' },
      dedupeKey: reviewDedupeKey({
        repositoryId: repo,
        changeRequestId: cr,
        headSha: 'h1',
        configDigest: 'c',
      }),
      runnerSelector: sel('cr-closed'),
    });
    const { jobId: untouched } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: { changeRequestId: other, headSha: 'h1' },
      dedupeKey: reviewDedupeKey({
        repositoryId: repo,
        changeRequestId: other,
        headSha: 'h1',
        configDigest: 'c',
      }),
      runnerSelector: sel('cr-closed'),
    });

    expect(await cancelReviewJobsForChangeRequest(db, TENANT, cr)).toBe(1);

    const mineRow = await db
      .selectFrom('jobs')
      .select(['status', 'cancellation_requested'])
      .where('id', '=', mine)
      .executeTakeFirstOrThrow();
    expect(mineRow.cancellation_requested).toBe(true);
    expect(mineRow.status).toBe('superseded');
    expect(await status(db, untouched)).toBe('queued');
  });

  it('ensureRunnerPool 并发启动仍只产生一个 (tenant, name) 身份', async () => {
    const name = `concurrent-${uuidv7()}`;
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => ensureRunnerPool(db, { tenantId: TENANT, name })),
    );
    expect(new Set(ids).size).toBe(1);
    const count = await db
      .selectFrom('runner_pools')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', TENANT)
      .where('name', '=', name)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });
});
