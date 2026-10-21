import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, runWithTenant, sql, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { createCrossTenantInvite } from '@reviewbot/multi-repo';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { AuthContext } from '../src/rbac.js';

/** End-to-end RLS through HTTP with a restricted DB role: requests must carry the authenticated tenant's context. */
const A = uuidv7();
const B = uuidv7();
const C = uuidv7();
const OPERATOR_SUBJECT = '424242';
const SECRET = 'integration-cross-tenant-secret';

interface Fixture {
  host: string;
  install: string;
  repo: string;
}

describe('control-api 租户隔离(受限角色 + RLS)', () => {
  let stop: () => Promise<void>;
  let admin: Db;
  let rlsDb: Db;
  let rlsEnd: () => Promise<void>;
  let app: FastifyInstance;
  let auth: AuthContext;
  const fx: Record<string, Fixture> = {};

  /** Tenant admin, not a platform operator. */
  const asTenant = (tenantId: string): AuthContext => ({
    role: 'admin',
    scopes: ['admin'],
    tenantId,
    actorId: '1001',
  });

  /** Admin of A (so requests carry A's context) and a platform operator. */
  const asOperator = (tenantId: string): AuthContext => ({
    ...asTenant(tenantId),
    actorId: OPERATOR_SUBJECT,
    identity: { provider: 'github', issuer: 'https://github.com', subject: OPERATOR_SUBJECT },
  });

  beforeAll(async () => {
    process.env.PLATFORM_OPERATOR_IDENTITIES = `github:${OPERATOR_SUBJECT}`;
    process.env.CROSS_TENANT_INVITE_SECRET = SECRET;

    const pg = await startMigratedPostgres();
    stop = pg.stop;
    admin = createDb(pg.pool);

    for (const [tenant, name] of [
      [A, 'alpha'],
      [B, 'beta'],
      [C, 'gamma'],
    ] as const) {
      await admin
        .insertInto('tenants')
        .values({ id: tenant, name, region: null, created_at: new Date() })
        .execute();
      const host = uuidv7();
      const install = uuidv7();
      const repo = uuidv7();
      fx[name] = { host, install, repo };
      await admin
        .insertInto('provider_hosts')
        .values({
          id: host,
          tenant_id: tenant,
          provider: 'github',
          base_url: 'https://github.com',
          api_url: 'https://api.github.com',
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
          native_id: name,
          account_login: name,
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
          native_id: name,
          namespace: name,
          name: 'app',
          clone_url: 'x',
          default_branch: 'main',
          created_at: new Date(),
        })
        .execute();
    }

    // A-B and B-C are active; A must see only A-B.
    for (const [source, target] of [
      [A, B],
      [B, C],
    ] as const) {
      const sourceName = source === A ? 'alpha' : 'beta';
      const targetName = target === B ? 'beta' : 'gamma';
      await admin
        .insertInto('cross_tenant_relationships')
        .values({
          id: uuidv7(),
          source_tenant_id: source,
          source_repository_id: fx[sourceName]!.repo,
          target_tenant_id: target,
          target_repository_id: fx[targetName]!.repo,
          kind: 'library-dependent',
          status: 'active',
          proposed_by: null,
          decided_by: null,
          rationale: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
    }

    for (const [tenant, name] of [
      [A, 'alpha'],
      [B, 'beta'],
    ] as const) {
      await admin
        .insertInto('jobs')
        .values({
          id: uuidv7(),
          tenant_id: tenant,
          type: 'review_revision',
          status: 'running',
          priority: 100,
          dedupe_key: `review-${name}`,
          payload: {},
          runner_selector: {},
          available_at: new Date(),
          lease_owner: null,
          lease_expires_at: null,
          attempt_count: 1,
          max_attempts: 3,
          cancellation_requested: false,
          superseded_by: null,
          last_error: null,
          created_at: new Date(),
          started_at: new Date(),
          completed_at: null,
          trace_context: null,
        })
        .execute();
    }

    // Grant full table access so RLS is the only isolation.
    await sql`create role rls_app login password 'rlspass'`.execute(admin);
    await sql`grant usage on schema public to rls_app`.execute(admin);
    await sql`grant select, insert, update, delete on all tables in schema public to rls_app`.execute(admin);
    const url = new URL(pg.connectionString);
    url.username = 'rls_app';
    url.password = 'rlspass';
    const rlsPool = createPool({ connectionString: url.toString() });
    rlsDb = createDb(rlsPool);
    rlsEnd = () => rlsPool.end();

    auth = asTenant(A);
    app = await buildServer({ quiet: true, db: rlsDb, rbac: { resolveAuth: () => auth } });
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.PLATFORM_OPERATOR_IDENTITIES;
    delete process.env.CROSS_TENANT_INVITE_SECRET;
    await app?.close();
    await rlsEnd?.();
    await stop?.();
  });

  const jobIdOf = async (tenant: string): Promise<string> => {
    const row = await admin
      .selectFrom('jobs')
      .select('id')
      .where('tenant_id', '=', tenant)
      .where('type', '=', 'review_revision')
      .executeTakeFirstOrThrow();
    return row.id;
  };

  it('底层机制:绑上租户的受限连接只看得见本租户的行', async () => {
    const seen = await runWithTenant(A, () => rlsDb.selectFrom('repositories').select('id').execute());
    expect(seen.map((r) => r.id)).toEqual([fx.alpha!.repo]);
  });

  it('列出跨租户关系只返回本租户是其中一侧的那些', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/cross-tenant-relationships' });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { sourceTenantId: string; targetTenantId: string; side: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceTenantId).toBe(A);
    expect(rows[0]!.targetTenantId).toBe(B);
    expect(rows[0]!.side).toBe('source');
  });

  it('停不掉别的租户的 review job(404,且那轮没被取消)', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/reviews/progress/${await jobIdOf(B)}/cancel` });
    expect(res.statusCode).toBe(404);
    const job = await admin
      .selectFrom('jobs')
      .select('cancellation_requested')
      .where('tenant_id', '=', B)
      .executeTakeFirstOrThrow();
    expect(job.cancellation_requested).toBe(false);
  });

  it('自己的 review job 停得掉', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/reviews/progress/${await jobIdOf(A)}/cancel` });
    expect(res.statusCode).toBe(200);
    const job = await admin
      .selectFrom('jobs')
      .select('cancellation_requested')
      .where('tenant_id', '=', A)
      .executeTakeFirstOrThrow();
    expect(job.cancellation_requested).toBe(true);
  });

  it('平台运维仍能停别的租户的 job(刻意跨租户的那条路)', async () => {
    auth = asOperator(A);
    const res = await app.inject({ method: 'POST', url: `/v1/reviews/progress/${await jobIdOf(B)}/cancel` });
    expect(res.statusCode).toBe(200);
    const job = await admin
      .selectFrom('jobs')
      .select('cancellation_requested')
      .where('tenant_id', '=', B)
      .executeTakeFirstOrThrow();
    expect(job.cancellation_requested).toBe(true);
    auth = asTenant(A);
  });

  it('兑换下游邀请建关系:两端分属两个租户,在 A 的上下文里也建得成', async () => {
    const token = createCrossTenantInvite(SECRET, {
      targetTenantId: B,
      targetRepositoryId: fx.beta!.repo,
      kind: 'api-consumer',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/cross-tenant-relationships/redeem',
      payload: { token, sourceRepositoryId: fx.alpha!.repo, rationale: 'integration' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; status: string };
    expect(body.status).toBe('proposed');
    const stored = await admin
      .selectFrom('cross_tenant_relationships')
      .select(['source_tenant_id', 'target_tenant_id', 'kind'])
      .where('id', '=', body.id)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ source_tenant_id: A, target_tenant_id: B, kind: 'api-consumer' });
  });

  it('运维批准待处理安装:给一个还不存在的租户建行也建得成', async () => {
    auth = asOperator(A);
    const pendingId = uuidv7();
    await admin
      .insertInto('pending_installations')
      .values({
        id: pendingId,
        provider: 'github',
        installation_native_id: `pending-${pendingId.slice(0, 8)}`,
        account_login: 'newcomer',
        installer_provider_user_id: '777',
        installer_login: 'newcomer-admin',
        status: 'pending',
        decided_by: null,
        decided_at: null,
        created_at: new Date(),
      })
      .execute();

    const res = await app.inject({ method: 'POST', url: `/v1/pending-installations/${pendingId}/approve` });
    expect(res.statusCode).toBe(200);
    const provisioned = await admin
      .selectFrom('provider_hosts')
      .innerJoin('installations', 'installations.provider_host_id', 'provider_hosts.id')
      .select(['provider_hosts.tenant_id as tenantId', 'installations.account_login as account'])
      .where('installations.native_id', '=', `pending-${pendingId.slice(0, 8)}`)
      .executeTakeFirstOrThrow();
    expect(provisioned.account).toBe('newcomer');
    expect(provisioned.tenantId).not.toBe(A);
    auth = asTenant(A);
  });

  it('匿名请求(无租户)看得见 UNSET 的全部行 —— 这正是必须显式加谓词的原因', async () => {
    auth = { role: 'admin', scopes: ['admin'] };
    const res = await app.inject({ method: 'GET', url: '/v1/cross-tenant-relationships' });
    // No tenant -> 400, never every tenant's relationships.
    expect(res.statusCode).toBe(400);
    auth = asTenant(A);
  });
});
