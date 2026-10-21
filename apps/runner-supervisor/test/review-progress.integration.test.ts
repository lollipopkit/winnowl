import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  createProgressReporter,
  finishProgress,
  sweepStaleProgress,
  writeProgress,
} from '../src/review-progress.js';

/*
 * In-flight review progress: one row per job (retries overwrite it), and the whole path is best effort
 * (write failures never reach the review).
 */
const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();
const JOB = uuidv7();

describe('review_progress 写入(0075)', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    await db.insertInto('change_requests').values({ id: CR, tenant_id: TENANT, repository_id: REPO, native_id: '42', number: 42, kind: 'pull-request', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() }).execute();
    await db.insertInto('revisions').values({ id: REV, tenant_id: TENANT, change_request_id: CR, base_sha: 'b', head_sha: 'h', merge_base_sha: null, created_at: new Date() }).execute();
    await db.insertInto('jobs').values({ id: JOB, tenant_id: TENANT, type: 'review_revision', status: 'running', payload: JSON.stringify({}) as unknown as Record<string, unknown>, runner_selector: JSON.stringify({}) as unknown as Record<string, unknown>, created_at: new Date() }).execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  const key = { jobId: JOB, tenantId: TENANT, repositoryId: REPO, changeRequestId: CR, revisionId: REV, attempt: 1 };
  const row = async (): Promise<{ stage: string; done: number | null; total: number | null; attempt: number; finished_at: Date | null }> =>
    db.selectFrom('review_progress').select(['stage', 'done', 'total', 'attempt', 'finished_at']).where('job_id', '=', JOB).executeTakeFirstOrThrow();

  it('阶段推进覆盖同一行 —— 一个 job 一条进度,不是一串历史', async () => {
    await writeProgress(db, key, { stage: 'prepare' });
    await writeProgress(db, key, { stage: 'dig', done: 4, total: 13 });
    expect(await row()).toMatchObject({ stage: 'dig', done: 4, total: 13 });
    const all = await db.selectFrom('review_progress').select('job_id').where('job_id', '=', JOB).execute();
    expect(all).toHaveLength(1);
  });

  it('没有可数单元的阶段清掉上一段的计数(否则 dig 的 4/13 会挂在 verify 上)', async () => {
    await writeProgress(db, key, { stage: 'synthesis' });
    expect(await row()).toMatchObject({ stage: 'synthesis', done: null, total: null });
  });

  it('收尾写 finished_at,行留着 —— 刚跑完那几分钟用户最想看它', async () => {
    await finishProgress(db, JOB, 'done');
    const r = await row();
    expect(r.stage).toBe('done');
    expect(r.finished_at).not.toBeNull();
  });

  it('重试把它挪回「进行中」并更新尝试次数 —— 否则界面上它一直是「已完成」', async () => {
    await writeProgress(db, { ...key, attempt: 2 }, { stage: 'prepare' });
    const r = await row();
    expect(r.attempt).toBe(2);
    expect(r.finished_at).toBeNull();
  });

  it('换一次尝试就重新起算 started_at —— 「已用」与「第 N 次尝试」是并排的两句话,得对得上', async () => {
    const at = async (): Promise<Date> =>
      (await db.selectFrom('review_progress').select('started_at').where('job_id', '=', JOB).executeTakeFirstOrThrow()).started_at as Date;
    const before = await at();
    // Progress within the same attempt keeps the start time.
    await writeProgress(db, { ...key, attempt: 2 }, { stage: 'dig', done: 1, total: 3 });
    expect((await at()).getTime()).toBe(before.getTime());
    // A new attempt restarts the clock.
    await writeProgress(db, { ...key, attempt: 3 }, { stage: 'prepare' });
    expect((await at()).getTime()).toBeGreaterThan(before.getTime());
  });

  // On cancellation a late fire-and-forget progress write could revive a finished row, which retention
  // (keyed on finished_at) would then never collect.
  it('收尾之后同一次尝试的迟到写入不能把行复活', async () => {
    await finishProgress(db, JOB, 'cancelled');
    await writeProgress(db, { ...key, attempt: 3 }, { stage: 'publish' });
    const r = await row();
    expect(r.stage).toBe('cancelled');
    expect(r.finished_at).not.toBeNull();
  });

  // finishProgress only runs in the handler; after SIGKILL the periodic sweep closes rows from the job's final state.
  it('job 已终态、进度还挂着 → 扫描按 job 状态收尾', async () => {
    const completedAt = new Date(Date.now() - 60_000);
    await db
      .updateTable('jobs')
      .set({ status: 'superseded', cancellation_requested: true, completed_at: completedAt })
      .where('id', '=', JOB)
      .execute();
    // The previous test finished the row; reopen it to simulate an orphaned row.
    await db
      .updateTable('review_progress')
      .set({ stage: 'publish', finished_at: null })
      .where('job_id', '=', JOB)
      .execute();

    expect(await sweepStaleProgress(db)).toBe(1);
    const r = await row();
    expect(r.stage).toBe('cancelled');
    // Closed at the job's end time, not the sweep time, so old rows do not look recent.
    expect(r.finished_at?.getTime()).toBe(completedAt.getTime());
    // Idempotent: finished rows are not rewritten.
    expect(await sweepStaleProgress(db)).toBe(0);
  });

  it('写失败被吞掉 —— 旁路不能把一跑已经在花钱的 review 拖垮', async () => {
    // Missing job → foreign key failure; report/finish must not throw.
    const bad = createProgressReporter(db, { ...key, jobId: uuidv7() });
    expect(() => bad.report({ stage: 'dig' })).not.toThrow();
    await expect(bad.finish('done')).resolves.toBeUndefined();
  });
});
