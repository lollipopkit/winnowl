import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  decideCrossTenantRelationship,
  listCrossTenantRelationships,
  loadActiveCrossTenantForSource,
  proposeCrossTenantRelationship,
} from '@reviewbot/multi-repo';

const UP = uuidv7(); // upstream tenant (source)
const DOWN = uuidv7(); // downstream tenant (target)
const UP_REPO = uuidv7();
const DOWN_REPO = uuidv7();

describe('跨租户关系状态机(§32,0042;双向确认)', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    for (const [tenant, repo, ns] of [
      [UP, UP_REPO, 'upstream'],
      [DOWN, DOWN_REPO, 'downstream'],
    ] as const) {
      const host = uuidv7();
      const install = uuidv7();
      await db
        .insertInto('tenants')
        .values({ id: tenant, name: ns, region: null, created_at: new Date() })
        .execute();
      await db
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
      await db
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
      await db
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
  });

  afterAll(async () => {
    await stop?.();
  });

  const propose = (): ReturnType<typeof proposeCrossTenantRelationship> =>
    proposeCrossTenantRelationship(db, {
      sourceTenantId: UP,
      sourceRepositoryId: UP_REPO,
      targetTenantId: DOWN,
      targetRepositoryId: DOWN_REPO,
      kind: 'library-dependent',
      proposedBy: 'upstream-admin',
    });

  const mainRelationship = async () => {
    const relationship = (await listCrossTenantRelationships(db, UP)).find(
      (row) => row.kind === 'library-dependent',
    );
    if (!relationship) throw new Error('main relationship fixture missing');
    return relationship;
  };

  it('上游发起 → proposed;未批准前不参与通知', async () => {
    const rel = await propose();
    expect(rel.status).toBe('proposed');
    expect(await loadActiveCrossTenantForSource(db, UP_REPO)).toEqual([]);
  });

  it('重复发起幂等,不重置对方尚未做的决定', async () => {
    const again = await propose();
    expect(again.status).toBe('proposed');
    expect(await listCrossTenantRelationships(db, UP)).toHaveLength(1);
  });

  it('并发首次发起收敛到同一条关系', async () => {
    const kind = `parallel-${uuidv7()}`;
    const input = {
      sourceTenantId: UP,
      sourceRepositoryId: UP_REPO,
      targetTenantId: DOWN,
      targetRepositoryId: DOWN_REPO,
      kind,
    };
    const rows = await Promise.all(
      Array.from({ length: 6 }, () => proposeCrossTenantRelationship(db, input)),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
  });

  it('发起时拒绝不一致的 repository/tenant 端点', async () => {
    await expect(
      proposeCrossTenantRelationship(db, {
        sourceTenantId: DOWN,
        sourceRepositoryId: UP_REPO,
        targetTenantId: UP,
        targetRepositoryId: DOWN_REPO,
        kind: `invalid-${uuidv7()}`,
      }),
    ).rejects.toThrow(/绑定无效/);
  });

  it('上游不能自己批准自己的申请(双向确认的核心)', async () => {
    const rel = await mainRelationship();
    expect(
      await decideCrossTenantRelationship(db, {
        id: rel.id,
        actingTenantId: UP,
        decision: 'approve',
      }),
    ).toBeNull();
    expect((await listCrossTenantRelationships(db, UP))[0]!.status).toBe('proposed');
  });

  it('非当事租户一律不可改', async () => {
    const rel = await mainRelationship();
    expect(
      await decideCrossTenantRelationship(db, {
        id: rel.id,
        actingTenantId: uuidv7(),
        decision: 'approve',
      }),
    ).toBeNull();
  });

  it('下游批准 → active,上游侧据此发通知', async () => {
    const rel = await mainRelationship();
    const updated = await decideCrossTenantRelationship(db, {
      id: rel.id,
      actingTenantId: DOWN,
      decision: 'approve',
      decidedBy: 'downstream-admin',
    });
    expect(updated?.status).toBe('active');
    const active = await loadActiveCrossTenantForSource(db, UP_REPO);
    expect(active).toHaveLength(1);
    expect(active[0]!.targetTenantId).toBe(DOWN);
  });

  it('并发 approve/reject 只有一个状态迁移成功', async () => {
    const relationship = await proposeCrossTenantRelationship(db, {
      sourceTenantId: UP,
      sourceRepositoryId: UP_REPO,
      targetTenantId: DOWN,
      targetRepositoryId: DOWN_REPO,
      kind: `decision-${uuidv7()}`,
    });
    const results = await Promise.all([
      decideCrossTenantRelationship(db, {
        id: relationship.id,
        actingTenantId: DOWN,
        decision: 'approve',
      }),
      decideCrossTenantRelationship(db, {
        id: relationship.id,
        actingTenantId: DOWN,
        decision: 'reject',
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = (await listCrossTenantRelationships(db, UP)).find(
      (row) => row.id === relationship.id,
    );
    expect(stored?.status).toBe(results.find(Boolean)?.status);
    if (stored?.status === 'active') {
      await decideCrossTenantRelationship(db, {
        id: relationship.id,
        actingTenantId: DOWN,
        decision: 'revoke',
      });
    }
  });

  it('已生效的关系任一侧都可单方撤销,撤销后立即不再通知', async () => {
    const rel = await mainRelationship();
    expect(
      (
        await decideCrossTenantRelationship(db, {
          id: rel.id,
          actingTenantId: UP,
          decision: 'revoke',
        })
      )?.status,
    ).toBe('revoked');
    expect(await loadActiveCrossTenantForSource(db, UP_REPO)).toEqual([]);
  });

  it('撤销后可重新申请(复位 proposed),但仍需下游再批一次', async () => {
    const again = await propose();
    expect(again.status).toBe('proposed');
    expect(await loadActiveCrossTenantForSource(db, UP_REPO)).toEqual([]);
  });

  it('同租户不进本表(应走 repository_relationships)', async () => {
    await expect(
      proposeCrossTenantRelationship(db, {
        sourceTenantId: UP,
        sourceRepositoryId: UP_REPO,
        targetTenantId: UP,
        targetRepositoryId: UP_REPO,
        kind: 'library-dependent',
      }),
    ).rejects.toThrow(/同租户/);
  });
});
