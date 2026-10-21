import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, runWithTenant, sql, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { listCrossTenantRelationships, recordCrossTenantEvent } from '../src/cross-tenant.js';

/** Cross-tenant events must be recordable under the restricted role in the source tenant's context. */
const UP = uuidv7();
const DOWN = uuidv7();
const UP_REPO = uuidv7();
const DOWN_REPO = uuidv7();
const REL = uuidv7();

describe('跨租户事件在 RLS 下的写入(A2)', () => {
  let stop: () => Promise<void>;
  let admin: Db;
  let rlsDb: Db;
  let rlsEnd: () => Promise<void>;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    stop = pg.stop;
    admin = createDb(pg.pool);

    for (const [tenant, repo, ns] of [
      [UP, UP_REPO, 'up'],
      [DOWN, DOWN_REPO, 'down'],
    ] as const) {
      const host = uuidv7();
      const install = uuidv7();
      await admin
        .insertInto('tenants')
        .values({ id: tenant, name: ns, region: null, created_at: new Date() })
        .execute();
      await admin
        .insertInto('provider_hosts')
        .values({
          id: host,
          tenant_id: tenant,
          provider: 'github',
          base_url: 'x',
          api_url: 'x',
          is_saas: true,
          created_at: new Date(),
        })
        .execute();
      await admin
        .insertInto('installations')
        .values({
          id: install,
          tenant_id: tenant,
          provider_host_id: host,
          native_id: ns,
          account_login: ns,
          status: 'active',
          created_at: new Date(),
        })
        .execute();
      await admin
        .insertInto('repositories')
        .values({
          id: repo,
          tenant_id: tenant,
          provider_host_id: host,
          installation_id: install,
          native_id: ns,
          namespace: ns,
          name: 'app',
          clone_url: 'x',
          default_branch: 'main',
          created_at: new Date(),
        })
        .execute();
    }

    await admin
      .insertInto('cross_tenant_relationships')
      .values({
        id: REL,
        source_tenant_id: UP,
        source_repository_id: UP_REPO,
        target_tenant_id: DOWN,
        target_repository_id: DOWN_REPO,
        kind: 'library-dependent',
        status: 'active',
        proposed_by: null,
        decided_by: null,
        rationale: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    await sql`create role rls_app login password 'rlspass'`.execute(admin);
    await sql`grant usage on schema public to rls_app`.execute(admin);
    await sql`grant select, insert, update, delete on all tables in schema public to rls_app`.execute(admin);
    const url = new URL(pg.connectionString);
    url.username = 'rls_app';
    url.password = 'rlspass';
    const rlsPool = createPool({ connectionString: url.toString() });
    rlsDb = createDb(rlsPool);
    rlsEnd = () => rlsPool.end();
  });

  afterAll(async () => {
    await rlsEnd?.();
    await stop?.();
  });

  const record = (revId: string) =>
    recordCrossTenantEvent(rlsDb, {
      relationshipId: REL,
      sourceTenantId: UP,
      sourceRepositoryId: UP_REPO,
      targetTenantId: DOWN,
      targetRepositoryId: DOWN_REPO,
      kind: 'contract-change',
      sourceRevisionId: revId,
      payload: { contractPaths: ['openapi.yaml'] },
    });

  it('上游租户上下文里记事件 → 成功落库(不再被"看不见 target 仓"判死)', async () => {
    const rev = uuidv7();
    const id = await runWithTenant(UP, () => record(rev));
    expect(id).toBeTruthy();
    const row = await admin
      .selectFrom('cross_tenant_events')
      .select(['source_tenant_id', 'target_tenant_id', 'attempt_count', 'failed_at'])
      .where('id', '=', id!)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      source_tenant_id: UP,
      target_tenant_id: DOWN,
      attempt_count: 0,
      failed_at: null,
    });
  });

  it('同一 revision 重复记为幂等(唯一索引仍生效)', async () => {
    const rev = uuidv7();
    expect(await runWithTenant(UP, () => record(rev))).toBeTruthy();
    expect(await runWithTenant(UP, () => record(rev))).toBeNull();
  });

  it('靶点与关系不符仍被拒(FK 兜住,不靠 join)', async () => {
    await expect(
      runWithTenant(UP, () =>
        recordCrossTenantEvent(rlsDb, {
          relationshipId: REL,
          sourceTenantId: UP,
          sourceRepositoryId: UP_REPO,
          targetTenantId: DOWN,
          targetRepositoryId: UP_REPO, // not this relationship's target
          kind: 'contract-change',
          sourceRevisionId: uuidv7(),
          payload: {},
        }),
      ),
    ).rejects.toThrow(/active relationship/);
  });

  it('下游租户看得见发给自己的事件,上游看得见自己发的', async () => {
    const rev = uuidv7();
    const id = await runWithTenant(UP, () => record(rev));
    const asDown = await runWithTenant(DOWN, () =>
      rlsDb.selectFrom('cross_tenant_events').select('id').execute(),
    );
    expect(asDown.map((r) => r.id)).toContain(id!);
    const asUp = await runWithTenant(UP, () =>
      rlsDb.selectFrom('cross_tenant_events').select('id').execute(),
    );
    expect(asUp.map((r) => r.id)).toContain(id!);
  });

  it('listCrossTenantRelationships 的显式谓词把别的租户的关系挡在外面', async () => {
    const other = uuidv7();
    const otherHost = uuidv7();
    const otherInstall = uuidv7();
    const otherRepo = uuidv7();
    await admin
      .insertInto('tenants')
      .values({ id: other, name: 'other', region: null, created_at: new Date() })
      .execute();
    await admin
      .insertInto('provider_hosts')
      .values({
        id: otherHost,
        tenant_id: other,
        provider: 'github',
        base_url: 'x',
        api_url: 'x',
        is_saas: true,
        created_at: new Date(),
      })
      .execute();
    await admin
      .insertInto('installations')
      .values({
        id: otherInstall,
        tenant_id: other,
        provider_host_id: otherHost,
        native_id: 'other',
        account_login: 'other',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await admin
      .insertInto('repositories')
      .values({
        id: otherRepo,
        tenant_id: other,
        provider_host_id: otherHost,
        installation_id: otherInstall,
        native_id: 'other',
        namespace: 'other',
        name: 'app',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await admin
      .insertInto('cross_tenant_relationships')
      .values({
        id: uuidv7(),
        source_tenant_id: DOWN,
        source_repository_id: DOWN_REPO,
        target_tenant_id: other,
        target_repository_id: otherRepo,
        kind: 'library-dependent',
        status: 'active',
        proposed_by: null,
        decided_by: null,
        rationale: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    const forUp = await listCrossTenantRelationships(rlsDb, UP);
    expect(forUp.map((r) => r.id)).toEqual([REL]);
    expect((await listCrossTenantRelationships(rlsDb, DOWN)).map((r) => r.id)).toHaveLength(2);
    expect(await listCrossTenantRelationships(rlsDb, other)).toHaveLength(1);
  });
});
