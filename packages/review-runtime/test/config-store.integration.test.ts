import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, loadEffectiveConfig, persistEffectiveConfig } from '@reviewbot/config';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const REPO_UNSEEDED = uuidv7();

describe('config-store — repository_settings 读写(§37)', () => {
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

  it('未落库 → 返回 defaultConfig()', async () => {
    const cfg = await loadEffectiveConfig(db, TENANT, REPO_UNSEEDED);
    expect(cfg.reviews.auto.enabled).toBe(true);
    expect(cfg.reviews.auto.drafts).toBe(false);
    expect(cfg.reviews.auto.base_branches).toEqual([]);
  });

  it('persist → load 往返;重复 persist 幂等覆盖(upsert)', async () => {
    const cfg = defaultConfig();
    cfg.reviews.auto.enabled = false;
    cfg.reviews.auto.drafts = true;
    cfg.language = 'zh';
    await persistEffectiveConfig(db, { tenantId: TENANT, repositoryId: REPO, settings: cfg, configDigest: 'dg1' });

    const loaded = await loadEffectiveConfig(db, TENANT, REPO);
    expect(loaded.reviews.auto.enabled).toBe(false);
    expect(loaded.reviews.auto.drafts).toBe(true);
    expect(loaded.language).toBe('zh');

    cfg.reviews.auto.enabled = true;
    await persistEffectiveConfig(db, { tenantId: TENANT, repositoryId: REPO, settings: cfg, configDigest: 'dg2' });
    const rows = await db.selectFrom('repository_settings').selectAll().where('repository_id', '=', REPO).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.config_digest).toBe('dg2');
    expect((await loadEffectiveConfig(db, TENANT, REPO)).reviews.auto.enabled).toBe(true);
  });

  it('存量行缺新增键(旧 schema 镜像)→ load 过 parse 补默认(2026-07-18 live 事故回归)', async () => {
    // A row mirrored under an older schema, lacking newer keys.
    const legacy = defaultConfig() as unknown as Record<string, unknown>;
    delete legacy.plugins;
    delete (legacy.knowledge as Record<string, unknown>).memory;
    await db
      .updateTable('repository_settings')
      .set({ settings: legacy })
      .where('repository_id', '=', REPO)
      .execute();

    const cfg = await loadEffectiveConfig(db, TENANT, REPO);
    expect(cfg.plugins.exa.enabled).toBe(true);
    expect(cfg.plugins.context7.enabled).toBe(true);
    expect(cfg.knowledge.memory.enabled).toBe(true);
  });

  it('organization defaults apply to every reader until the repository sets its own value', async () => {
    const repo = uuidv7();
    await db.insertInto('repositories').values({ id: repo, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '901', namespace: 'acme', name: 'lib', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    await db.updateTable('tenants').set({ settings: { language: 'ja', reviews: { profile: 'thorough' }, unrelated: 1 } }).where('id', '=', TENANT).execute();
    // Never reviewed: the organization's defaults.
    expect((await loadEffectiveConfig(db, TENANT, repo)).language).toBe('ja');
    // The repository file sets the profile only; the language still comes from the organization.
    const cfg = defaultConfig();
    cfg.reviews.profile = 'conservative';
    await persistEffectiveConfig(db, { tenantId: TENANT, repositoryId: repo, settings: cfg, configDigest: 'f1', fileSettings: { reviews: { profile: 'conservative' } } });
    const loaded = await loadEffectiveConfig(db, TENANT, repo);
    expect(loaded.reviews.profile).toBe('conservative');
    expect(loaded.language).toBe('ja');
    // A change to the organization applies without another review.
    await db.updateTable('tenants').set({ settings: { language: 'de' } }).where('id', '=', TENANT).execute();
    expect((await loadEffectiveConfig(db, TENANT, repo)).language).toBe('de');
    await db.updateTable('tenants').set({ settings: {} }).where('id', '=', TENANT).execute();
  });
});
