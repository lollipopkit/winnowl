import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { createLocalMasterKey, type MasterKeyProvider } from '@reviewbot/kms';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { deleteServiceCredential, listServiceCredentials, resolveServiceCredentials, storeServiceCredential } from '../src/index.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const OTHER_REPO = uuidv7();

describe('service_credentials store(§插件 BYOK,0033)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let kek: MasterKeyProvider;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    kek = createLocalMasterKey('kek-test', randomBytes(32));
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    for (const [i, id] of [REPO, OTHER_REPO].entries()) {
      await db.insertInto('repositories').values({ id, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: `70${i}`, namespace: 'acme', name: `r${i}`, clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    }
  });

  afterAll(async () => {
    await stop?.();
  });

  it('org 级写入 → 密文落库(不含明文)+ upsert 覆盖', async () => {
    await storeServiceCredential(db, kek, { tenantId: TENANT, service: 'exa', apiKey: 'org-exa-v1' });
    await storeServiceCredential(db, kek, { tenantId: TENANT, service: 'exa', apiKey: 'org-exa-v2' });
    const rows = await db.selectFrom('service_credentials').selectAll().where('tenant_id', '=', TENANT).where('service', '=', 'exa').execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.envelope)).not.toContain('org-exa');
    const resolved = await resolveServiceCredentials(db, kek, { tenantId: TENANT, repositoryId: REPO });
    expect(resolved.exa).toBe('org-exa-v2');
  });

  it('repo 级覆盖 org 级;其它 repo 仍用 org 级', async () => {
    await storeServiceCredential(db, kek, { tenantId: TENANT, service: 'exa', apiKey: 'repo-exa', repositoryId: REPO });
    expect((await resolveServiceCredentials(db, kek, { tenantId: TENANT, repositoryId: REPO })).exa).toBe('repo-exa');
    expect((await resolveServiceCredentials(db, kek, { tenantId: TENANT, repositoryId: OTHER_REPO })).exa).toBe('org-exa-v2');
  });

  it('list 只回脱敏元数据;delete 按级删除', async () => {
    await storeServiceCredential(db, kek, { tenantId: TENANT, service: 'context7', apiKey: 'c7-org' });
    const metas = await listServiceCredentials(db, TENANT);
    expect(metas.map((m) => `${m.service}:${m.scope}`).sort()).toEqual(['context7:org', 'exa:org', 'exa:repo']);
    expect(JSON.stringify(metas)).not.toContain('c7-org');

    await deleteServiceCredential(db, { tenantId: TENANT, service: 'exa', repositoryId: REPO });
    expect((await resolveServiceCredentials(db, kek, { tenantId: TENANT, repositoryId: REPO })).exa).toBe('org-exa-v2');
  });

  it('user 级(账户)最高优先:user > repo > org;未给 userId 不参与', async () => {
    const USER = uuidv7();
    await db.insertInto('users').values({ id: USER, email: 'u@x.co', display_name: null, created_at: new Date() }).execute();
    await storeServiceCredential(db, kek, { tenantId: TENANT, service: 'exa', apiKey: 'user-exa', userId: USER });
    await storeServiceCredential(db, kek, { tenantId: TENANT, service: 'exa', apiKey: 'repo-exa2', repositoryId: REPO });
    expect((await resolveServiceCredentials(db, kek, { tenantId: TENANT, repositoryId: REPO, userId: USER })).exa).toBe('user-exa');
    expect((await resolveServiceCredentials(db, kek, { tenantId: TENANT, repositoryId: REPO })).exa).toBe('repo-exa2');
  });

  it('repo 级与 user 级互斥(DB check)', async () => {
    await expect(
      storeServiceCredential(db, kek, { tenantId: TENANT, service: 'exa', apiKey: 'x', repositoryId: REPO, userId: uuidv7() }),
    ).rejects.toThrow(/互斥/);
  });
});
