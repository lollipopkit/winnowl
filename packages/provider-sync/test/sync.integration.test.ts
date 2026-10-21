import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import type { RepositoryRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { syncInstallationRepositories } from '../src/index.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();

function repoRef(nativeId: string, name: string): RepositoryRef {
  return {
    id: uuidv7(),
    providerHostId: HOST,
    installationId: INSTALL,
    nativeId,
    namespace: 'acme',
    name,
    cloneUrl: `https://x/acme/${name}.git`,
    defaultBranch: 'main',
  };
}

describe('syncInstallationRepositories', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'https://github.com', api_url: 'https://api.github.com', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '999', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  it('拉取并 upsert 仓库,重复运行幂等', async () => {
    const list = async () => [repoRef('900', 'app'), repoRef('901', 'lib')];
    const first = await syncInstallationRepositories(db, {
      listRepositories: list,
      tenantId: TENANT,
      providerHostId: HOST,
      installationNativeId: '999',
      internalInstallationId: INSTALL,
    });
    expect(first.synced).toBe(2);

    const count1 = await db.selectFrom('repositories').select((eb) => eb.fn.countAll<string>().as('n')).where('provider_host_id', '=', HOST).executeTakeFirstOrThrow();
    expect(Number(count1.n)).toBe(2);

    // A renamed repository updates the row instead of inserting a duplicate.
    const list2 = async () => [repoRef('900', 'app-renamed'), repoRef('901', 'lib')];
    await syncInstallationRepositories(db, {
      listRepositories: list2,
      tenantId: TENANT,
      providerHostId: HOST,
      installationNativeId: '999',
      internalInstallationId: INSTALL,
    });
    const count2 = await db.selectFrom('repositories').select((eb) => eb.fn.countAll<string>().as('n')).where('provider_host_id', '=', HOST).executeTakeFirstOrThrow();
    expect(Number(count2.n)).toBe(2);
    const renamed = await db.selectFrom('repositories').selectAll().where('native_id', '=', '900').executeTakeFirst();
    expect(renamed?.name).toBe('app-renamed');
  });
});
