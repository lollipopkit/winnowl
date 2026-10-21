import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres } from '@reviewbot/testkit';
import { migrationsDir } from '@reviewbot/testkit';
import { createDb, createPool, runMigrations } from '../src/index.js';
import type { Db } from '../src/index.js';
import type pg from 'pg';

// Requires Docker; run via `pnpm test:integration`.
describe('数据库迁移', () => {
  let stop: () => Promise<void>;
  let pool: pg.Pool;
  let db: Db;

  beforeAll(async () => {
    const started = await startPostgres();
    pool = createPool({ connectionString: started.connectionString });
    db = createDb(pool);
    stop = async () => {
      await pool.end();
      await started.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  it('空库应用全部迁移', async () => {
    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied[0]).toBe('0001_init');
    expect(result.skipped).toHaveLength(0);
    // The baseline seeds the plans the entitlement code falls back to.
    const plans = await db.selectFrom('plans').select('key').orderBy('key').execute();
    expect(plans.map((p) => p.key)).toEqual(['enterprise', 'free', 'internal', 'pro']);
  });

  it('升级库重复运行全部跳过(幂等)', async () => {
    const result = await runMigrations(pool, migrationsDir);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toContain('0001_init');
  });

  it('迁移后可对核心表进行 tenant 作用域写入/查询', async () => {
    const tenantId = '018f9a3c-7b2e-7c3d-8a1b-2c3d4e5f6a7b';
    await db
      .insertInto('tenants')
      .values({ id: tenantId, name: 'acme', region: null, created_at: new Date() })
      .execute();

    const row = await db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', tenantId)
      .executeTakeFirst();

    expect(row?.name).toBe('acme');
  });
});
