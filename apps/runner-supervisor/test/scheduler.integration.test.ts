import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { DAYS, MINUTES, githubAppTargets, periodBucket, runPeriodicEnqueue, type PeriodicSpec } from '../src/scheduler.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();

describe('周期任务入队(§35/§32/§43 定时)', () => {
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
  });

  afterAll(async () => {
    await stop?.();
  });

  const retention = (): PeriodicSpec => ({
    type: 'retention_sweep',
    everyMs: DAYS,
    targets: async (database) =>
      (await database.selectFrom('tenants').select('id').execute()).map((t) => ({ tenantId: t.id, key: t.id, payload: { tenantId: t.id } })),
  });

  it('同一周期桶内只入队一次 —— 即便前一次已 completed(active-only dedupe 挡不住)', async () => {
    const now = Date.UTC(2026, 6, 29, 3, 0, 0);
    expect((await runPeriodicEnqueue(db, [retention()], { now })).enqueued).toBe(1);

    // Simulate a finished run: the active-only unique index no longer blocks, so the periodic gate must.
    await db.updateTable('jobs').set({ status: 'completed', completed_at: new Date() }).where('type', '=', 'retention_sweep').execute();

    const again = await runPeriodicEnqueue(db, [retention()], { now: now + 6 * 60 * 60 * 1000 }); // later the same day
    expect(again.enqueued).toBe(0);
    expect(again.skipped).toBe(1);
    expect(await countJobs(db, 'retention_sweep')).toBe(1);
  });

  it('多个 supervisor 并发跨过 completed 桶检查时仍只入队一次', async () => {
    const now = Date.UTC(2026, 7, 2, 3, 0, 0);
    const concurrentSpec = { ...retention(), type: 'relationship_discover' };
    const results = await Promise.all([
      runPeriodicEnqueue(db, [concurrentSpec], { now }),
      runPeriodicEnqueue(db, [concurrentSpec], { now }),
    ]);
    expect(results.reduce((sum, result) => sum + result.enqueued, 0)).toBe(1);
    expect(await countJobs(db, 'relationship_discover')).toBe(1);
  });

  it('跨到下一个桶 → 再入队一次', async () => {
    const nextDay = Date.UTC(2026, 6, 30, 3, 0, 0);
    expect((await runPeriodicEnqueue(db, [retention()], { now: nextDay })).enqueued).toBe(1);
    expect(await countJobs(db, 'retention_sweep')).toBe(2);
  });

  it('everyMs<=0 视为关闭:security_scan 默认不排(全仓 LLM 扫描须显式开)', async () => {
    const spec: PeriodicSpec = {
      type: 'security_scan',
      everyMs: 0,
      targets: async (database) =>
        (await database.selectFrom('repositories').select(['id', 'tenant_id']).execute()).map((r) => ({
          tenantId: r.tenant_id,
          key: r.id,
          payload: { tenantId: r.tenant_id, repositoryId: r.id, trigger: 'scheduled' },
        })),
    };
    expect((await runPeriodicEnqueue(db, [spec], { now: Date.now() })).enqueued).toBe(0);
    expect(await countJobs(db, 'security_scan')).toBe(0);

    // When enabled, enqueued per repository with a scheduled trigger source.
    const enabled = { ...spec, everyMs: 7 * DAYS };
    expect((await runPeriodicEnqueue(db, [enabled], { now: Date.UTC(2026, 6, 29) })).enqueued).toBe(1);
    const row = await db.selectFrom('jobs').select(['payload', 'dedupe_key']).where('type', '=', 'security_scan').executeTakeFirst();
    expect((row?.payload as { trigger?: string })?.trigger).toBe('scheduled');
    expect(row?.dedupe_key).toContain(REPO);
  });

  it('目标解析抛错 → 该 spec 跳过,不影响同轮其它 spec', async () => {
    const boom: PeriodicSpec = { type: 'relationship_discover', everyMs: DAYS, targets: async () => { throw new Error('db down'); } };
    const logs: string[] = [];
    const res = await runPeriodicEnqueue(db, [boom, retention()], { now: Date.UTC(2026, 7, 1), log: (m) => logs.push(m) });
    expect(res.enqueued).toBe(1); // retention as usual
    expect(logs.some((l) => l.includes('目标解析失败'))).toBe(true);
  });

  it('periodBucket 按周期对齐;支持分钟级(跨租户 intake 用)', () => {
    expect(periodBucket(Date.UTC(2026, 6, 29, 0, 0, 1), DAYS)).toBe(periodBucket(Date.UTC(2026, 6, 29, 23, 59), DAYS));
    expect(periodBucket(Date.UTC(2026, 6, 30), DAYS)).toBe(periodBucket(Date.UTC(2026, 6, 29), DAYS) + 1);
    // Minute-level: the same number within a 5-minute window, +1 across windows.
    expect(periodBucket(Date.UTC(2026, 6, 29, 0, 1), 5 * MINUTES)).toBe(periodBucket(Date.UTC(2026, 6, 29, 0, 4), 5 * MINUTES));
    expect(periodBucket(Date.UTC(2026, 6, 29, 0, 5), 5 * MINUTES)).toBe(periodBucket(Date.UTC(2026, 6, 29, 0, 0), 5 * MINUTES) + 1);
  });

  it('App 级任务只挂在最早持有 GitHub host 的租户下,多租户也只排一次', async () => {
    const other = uuidv7();
    await db.insertInto('tenants').values({ id: other, name: 'later', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: uuidv7(), tenant_id: other, provider: 'github', base_url: 'y', api_url: 'y', is_saas: true, created_at: new Date(Date.now() + 1000) }).execute();
    expect(await githubAppTargets(db)).toEqual([{ tenantId: TENANT, key: 'app', payload: { tenantId: TENANT } }]);
  });
});

async function countJobs(db: Db, type: string): Promise<number> {
  const row = await db.selectFrom('jobs').select(db.fn.countAll().as('n')).where('type', '=', type).executeTakeFirst();
  return Number(row?.n ?? 0);
}
