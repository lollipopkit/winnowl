import { createDb, createPool, runWithTenant, runWithoutTenant, withTenantScope, type Db } from '@reviewbot/db';
import { sql } from 'kysely';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const T1 = '018f0000-0000-7000-8000-000000000001';
const T2 = '018f0000-0000-7000-8000-000000000002';
const HOST = '018f0000-0000-7000-8000-0000000000a1';
const INST = '018f0000-0000-7000-8000-0000000000a2';
const REPO1 = '018f0000-0000-7000-8000-0000000000b1';
const REPO2 = '018f0000-0000-7000-8000-0000000000b2';

describe('PostgreSQL RLS 租户隔离', () => {
  let stop: () => Promise<void>;
  let admin: Db; // superuser, bypasses RLS; used for seeding
  let rlsDb: Db; // restricted role, RLS applies
  let rlsEnd: () => Promise<void>;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    stop = pg.stop;
    admin = createDb(pg.pool);

    for (const t of [T1, T2]) {
      await admin.insertInto('tenants').values({ id: t, name: `t-${t.slice(-1)}`, region: null, created_at: new Date() }).execute();
    }
    await admin.insertInto('provider_hosts').values({ id: HOST, tenant_id: T1, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await admin.insertInto('installations').values({ id: INST, tenant_id: T1, provider_host_id: HOST, native_id: '1', account_login: 'a', status: 'active', created_at: new Date() }).execute();
    // Both repos reference T1's host/installation; only tenant_id isolation is under test.
    await admin.insertInto('repositories').values({ id: REPO1, tenant_id: T1, provider_host_id: HOST, installation_id: INST, native_id: '100', namespace: 'a', name: 'r1', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    await admin.insertInto('repositories').values({ id: REPO2, tenant_id: T2, provider_host_id: HOST, installation_id: INST, native_id: '200', namespace: 'a', name: 'r2', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();

    await sql`create role rls_app login password 'rlspass'`.execute(admin);
    await sql`grant usage on schema public to rls_app`.execute(admin);
    await sql`grant select, insert on repositories to rls_app`.execute(admin);

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

  it('未设 GUC(permissive-when-unset)→ 受限角色可见两仓(行为不变)', async () => {
    const rows = await rlsDb.selectFrom('repositories').select('id').execute();
    expect(rows.map((r) => r.id).sort()).toEqual([REPO1, REPO2].sort());
  });

  it('设 app.tenant_id=T1(withTenantScope)→ 仅见 T1 的仓', async () => {
    const rows = await withTenantScope(rlsDb, T1, (trx) => trx.selectFrom('repositories').select(['id', 'tenant_id']).execute());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(REPO1);
    expect(rows[0]!.tenant_id).toBe(T1);
  });

  it('设 app.tenant_id=T2 → 仅见 T2 的仓(跨租户不可见)', async () => {
    const rows = await withTenantScope(rlsDb, T2, (trx) => trx.selectFrom('repositories').select('id').execute());
    expect(rows.map((r) => r.id)).toEqual([REPO2]);
  });

  it('GUC 仅事务内(set_config is_local)→ 事务外恢复 permissive', async () => {
    await withTenantScope(rlsDb, T1, (trx) => trx.selectFrom('repositories').select('id').execute());
    const after = await rlsDb.selectFrom('repositories').select('id').execute();
    expect(after).toHaveLength(2); // GUC ends with the transaction: back to permissive-when-unset
  });

  it('superuser 连接绕过 RLS(seed/维护不受影响)', async () => {
    const rows = await admin.selectFrom('repositories').select('id').execute();
    expect(rows).toHaveLength(2);
  });

  it('§38.7 强制启用:ALS 上下文(runWithTenant)+ 受限角色 → 非事务查询也被隔离;逃生舱恢复全见;上下文外连接被复位', async () => {
    const inT1 = await runWithTenant(T1, () => rlsDb.selectFrom('repositories').select('id').execute());
    expect(inT1.map((r) => r.id)).toEqual([REPO1]);
    // RLS WITH CHECK rejects writing a T2 row from T1's context.
    await expect(
      runWithTenant(T1, () =>
        rlsDb
          .insertInto('repositories')
          .values({ id: crypto.randomUUID(), tenant_id: T2, provider_host_id: HOST, installation_id: INST, native_id: '300', namespace: 'a', name: 'r3', clone_url: 'x', default_branch: 'main', created_at: new Date() })
          .execute(),
      ),
    ).rejects.toThrow();
    const escaped = await runWithTenant(T1, () => runWithoutTenant(() => rlsDb.selectFrom('repositories').select('id').execute()));
    expect(escaped.map((r) => r.id).sort()).toEqual([REPO1, REPO2].sort());
    // Outside any context the pooled connection (possibly just used by T1) must be reset to unset.
    const outside = await rlsDb.selectFrom('repositories').select('id').execute();
    expect(outside.map((r) => r.id).sort()).toEqual([REPO1, REPO2].sort());
  });

  // RLS applies per table, so child tables need their own tenant_id and policy (anchor_text holds source code).
  it('finding 子表也受隔离:occurrences / dismissals 各自带 tenant_id 且有策略', async () => {
    const [f1, f2] = ['018f0000-0000-7000-8000-0000000000f1', '018f0000-0000-7000-8000-0000000000f2'];
    const [cr1, cr2] = ['018f0000-0000-7000-8000-0000000000c1', '018f0000-0000-7000-8000-0000000000c2'];
    const [rev1, rev2] = ['018f0000-0000-7000-8000-0000000000e1', '018f0000-0000-7000-8000-0000000000e2'];
    for (const [f, t, repo, cr, rev, occId, disId] of [
      [f1, T1, REPO1, cr1, rev1, '018f0000-0000-7000-8000-0000000000a1', '018f0000-0000-7000-8000-0000000000b8'],
      [f2, T2, REPO2, cr2, rev2, '018f0000-0000-7000-8000-0000000000a2', '018f0000-0000-7000-8000-0000000000b9'],
    ] as const) {
      await admin.insertInto('change_requests').values({ id: cr, tenant_id: t, repository_id: repo, native_id: cr, number: 1, kind: 'pull_request', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() }).execute();
      await admin.insertInto('revisions').values({ id: rev, tenant_id: t, change_request_id: cr, base_sha: 'b', head_sha: rev, merge_base_sha: null, source_branch: null, target_branch: null, created_at: new Date() }).execute();
      await admin.insertInto('findings').values({ id: f, tenant_id: t, repository_id: repo, semantic_fingerprint: `fp-${f}`, category: 'correctness', canonical_claim: 'x', lifecycle: 'new', first_seen_at: new Date(), last_seen_at: new Date() }).execute();
      await admin.insertInto('finding_occurrences').values({ id: occId, tenant_id: t, finding_id: f, review_run_id: null, revision_id: rev, state: 'published', severity: 'high', change_relation: 'introduced', confirmation: 'independently-verified', anchor: null, anchor_text: 'secret_code_of_' + t.slice(-1), evidence: [], created_at: new Date() }).execute();
      await admin.insertInto('finding_dismissals').values({ id: disId, tenant_id: t, finding_id: f, change_request_id: cr, actor: 'someone', created_at: new Date() }).execute();
    }
    await sql`grant select on finding_occurrences to rls_app`.execute(admin);
    await sql`grant select on finding_dismissals to rls_app`.execute(admin);

    const occ = await runWithTenant(T1, () => rlsDb.selectFrom('finding_occurrences').select(['tenant_id', 'anchor_text']).execute());
    expect(occ.map((o) => o.tenant_id)).toEqual([T1]);
    const dis = await runWithTenant(T1, () => rlsDb.selectFrom('finding_dismissals').select('tenant_id').execute());
    expect(dis.map((d) => d.tenant_id)).toEqual([T1]);
    // Unset GUC stays permissive.
    expect(await rlsDb.selectFrom('finding_occurrences').select('id').execute()).toHaveLength(2);
  });
});
