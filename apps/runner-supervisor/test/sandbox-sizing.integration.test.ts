import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDb, sql, type Db } from '@reviewbot/db';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { loadSizing, recordSizing } from '../src/sandbox-sizing.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();

describe('sandbox_sizing', () => {
  let db: Db;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '9', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
  });
  afterAll(async () => {
    await stop?.();
  });

  it('keeps the larger of a new peak and the stored one decayed by 10 %', async () => {
    const key = { tenantId: TENANT, repositoryId: REPO, kind: 'validation' as const };
    expect(await loadSizing(db, REPO, 'validation')).toBeUndefined();
    await recordSizing(db, key, { memoryPeakMb: 4000, diskPeakMb: 5000 });
    expect(await loadSizing(db, REPO, 'validation')).toEqual({ memoryPeakMb: 4000, diskPeakMb: 5000, samples: 1 });
    // A smaller run lowers the record slowly, a bigger one raises it at once.
    await recordSizing(db, key, { memoryPeakMb: 1000, diskPeakMb: 6000 });
    expect(await loadSizing(db, REPO, 'validation')).toEqual({ memoryPeakMb: 3600, diskPeakMb: 6000, samples: 2 });
  });

  it('0009 strips the old sandbox defaults from mirrored settings, but not a value the console set', async () => {
    const old = { sandbox: { network: { mode: 'none', hosts: [], ports: [], ecosystems: [] }, resources: { cpu: 4, disk_mb: 20480, memory_mb: 8192, timeout_seconds: 1800 } } };
    await db
      .insertInto('repository_settings')
      .values({ repository_id: REPO, tenant_id: TENANT, settings: old, source: 'repo-file', updated_at: new Date() })
      .execute();
    expect((await loadEffectiveConfig(db, TENANT, REPO)).sandbox.network.mode).toBe('none');
    await sql.raw(readFileSync(new URL('../../../migrations/0009_sandbox_config_defaults.sql', import.meta.url), 'utf8')).execute(db);
    const cfg = await loadEffectiveConfig(db, TENANT, REPO);
    expect(cfg.sandbox.network.mode).toBeUndefined();
    expect(cfg.sandbox.resources).toEqual({});

    // Set in the console: kept.
    await db
      .updateTable('repository_settings')
      .set({ settings: old, panel_settings: { sandbox: { network: { mode: 'none' } } } })
      .where('repository_id', '=', REPO)
      .execute();
    await sql.raw(readFileSync(new URL('../../../migrations/0009_sandbox_config_defaults.sql', import.meta.url), 'utf8')).execute(db);
    expect((await loadEffectiveConfig(db, TENANT, REPO)).sandbox.network.mode).toBe('none');
  });
});
