import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { AuthContext } from '../src/rbac.js';

const TENANT = uuidv7();
const OTHER_TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const USER = uuidv7();
const OP_SUB = 'op-sub-console';

describe('租户面端点(ADR-014)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let admin: FastifyInstance;
  let memberApp: FastifyInstance;
  let operator: FastifyInstance;
  let prevOperatorSubs: string | undefined;

  const build = (auth: AuthContext) =>
    buildServer({ quiet: true, db, rbac: { resolveAuth: () => auth } });

  beforeAll(async () => {
    prevOperatorSubs = process.env.PLATFORM_OPERATOR_IDENTITIES;
    process.env.PLATFORM_OPERATOR_IDENTITIES = `github:${OP_SUB}`;
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values([
        { id: TENANT, name: 'acme', region: null, created_at: new Date() },
        { id: OTHER_TENANT, name: 'beta', region: null, created_at: new Date() },
      ])
      .execute();
    await db
      .insertInto('provider_hosts')
      .values({
        id: HOST,
        tenant_id: TENANT,
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
        id: INSTALL,
        tenant_id: TENANT,
        provider_host_id: HOST,
        native_id: '1',
        account_login: 'acme',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('repositories')
      .values({
        id: REPO,
        tenant_id: TENANT,
        provider_host_id: HOST,
        installation_id: INSTALL,
        native_id: '9',
        namespace: 'acme',
        name: 'app',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('users')
      .values({ id: USER, email: 'u@acme.io', display_name: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('memberships')
      .values([
        {
          id: uuidv7(),
          tenant_id: TENANT,
          user_id: USER,
          role: 'admin',
          status: 'active',
          created_at: new Date(),
        },
        {
          id: uuidv7(),
          tenant_id: OTHER_TENANT,
          user_id: USER,
          role: 'viewer',
          status: 'active',
          created_at: new Date(),
        },
      ])
      .execute();
    await db
      .insertInto('review_costs')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        repository_id: REPO,
        change_request_id: null,
        revision_id: uuidv7(),
        input_tokens: '100',
        output_tokens: '50',
        total_tokens: '150',
        cost_usd: '0.01',
        candidate_count: 3,
        published_inline: 2,
        scopes_total: 1,
        scopes_complete: 1,
        created_at: new Date(),
      })
      .execute();
    const cr = uuidv7();
    const rev = uuidv7();
    await db
      .insertInto('change_requests')
      .values({ id: cr, tenant_id: TENANT, repository_id: REPO, native_id: '7', number: 7, kind: 'pull-request', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() })
      .execute();
    await db
      .insertInto('revisions')
      .values({ id: rev, tenant_id: TENANT, change_request_id: cr, base_sha: 'b', head_sha: 'h', merge_base_sha: null, source_branch: 'f', target_branch: 'main', created_at: new Date() })
      .execute();
    const finding = (lifecycle: string, claim: string) => ({ id: uuidv7(), tenant_id: TENANT, repository_id: REPO, semantic_fingerprint: claim, category: 'correctness', canonical_claim: claim, lifecycle, first_seen_at: new Date(), last_seen_at: new Date() });
    const open = finding('new', 'open one');
    const fixed = finding('resolved', 'fixed one');
    const hidden = finding('new', 'not posted');
    await db.insertInto('findings').values([open, fixed, hidden]).execute();
    const occ = (findingId: string, state: string, severity: string) => ({ id: uuidv7(), tenant_id: TENANT, finding_id: findingId, revision_id: rev, state, severity, change_relation: 'introduced', confirmation: 'independently-verified', anchor: { path: 'a.ts', line: 3 }, created_at: new Date() });
    await db
      .insertInto('finding_occurrences')
      .values([occ(open.id, 'inline', 'high'), occ(fixed.id, 'summary', 'low'), occ(hidden.id, 'suppressed', 'critical')])
      .execute();
    // Shared pool (tenant_id NULL) visible to operators only. Rows are workers, so each pool needs one to appear.
    const sharedPool = uuidv7();
    const acmePool = uuidv7();
    const betaPool = uuidv7();
    await db
      .insertInto('runner_pools')
      .values([
        { id: sharedPool, tenant_id: null, name: 'shared-pool', created_at: new Date() },
        { id: acmePool, tenant_id: TENANT, name: 'acme-pool', created_at: new Date() },
        { id: betaPool, tenant_id: OTHER_TENANT, name: 'beta-pool', created_at: new Date() },
      ])
      .execute();
    await db
      .insertInto('workers')
      .values(
        [sharedPool, acmePool, betaPool].map((poolId) => ({
          id: uuidv7(),
          pool_id: poolId,
          mode: 'active',
          version: '1.0.0',
          capabilities: {},
          max_concurrency: 1,
          running_jobs: 0,
          last_heartbeat_at: new Date(),
          registered_at: new Date(),
        })),
      )
      .execute();

    admin = await build({
      role: 'admin',
      scopes: ['admin'],
      tenantId: TENANT,
      actorId: 'admin-sub',
      userId: USER,
    });
    memberApp = await build({
      role: 'member',
      scopes: [],
      tenantId: TENANT,
      actorId: 'member-sub',
    });
    operator = await build({
      role: 'admin',
      scopes: ['admin'],
      actorId: OP_SUB,
      userId: USER,
      identity: { provider: 'github', issuer: 'https://github.com', subject: OP_SUB },
    });
    await Promise.all([admin.ready(), memberApp.ready(), operator.ready()]);
  });

  afterAll(async () => {
    if (prevOperatorSubs === undefined) delete process.env.PLATFORM_OPERATOR_IDENTITIES;
    else process.env.PLATFORM_OPERATOR_IDENTITIES = prevOperatorSubs;
    await Promise.all([admin?.close(), memberApp?.close(), operator?.close()]);
    await stop?.();
  });

  it('/v1/me:身份 + memberships(DB 模式,userId 存在)+ operator 标记', async () => {
    const res = await admin.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      role: string;
      tenantId: string;
      isOperator: boolean;
      memberships: { tenantId: string; role: string }[];
    };
    expect(body.role).toBe('admin');
    expect(body.tenantId).toBe(TENANT);
    expect(body.isOperator).toBe(false);
    expect(body.memberships).toHaveLength(2);
    const op = await operator.inject({ method: 'GET', url: '/v1/me' });
    expect((op.json() as { isOperator: boolean }).isOperator).toBe(true);
    // No userId -> no memberships.
    const m = await memberApp.inject({ method: 'GET', url: '/v1/me' });
    expect((m.json() as { memberships: unknown[] }).memberships).toHaveLength(0);
  });

  // A user without memberships needs the install URL and pending-approval state from /v1/me for onboarding.
  it('/v1/me:无 membership → 给安装地址;本人提交的待批安装被认出来', async () => {
    const prevSlug = process.env.GITHUB_APP_SLUG;
    process.env.GITHUB_APP_SLUG = 'winnowl';
    const newcomer = await build({
      role: 'viewer',
      scopes: [],
      actorId: '79314033',
      identity: { provider: 'github', issuer: 'https://github.com', subject: '79314033' },
    });
    try {
      await newcomer.ready();
      const fresh = (await newcomer.inject({ method: 'GET', url: '/v1/me' })).json() as {
        memberships: unknown[];
        installUrl: string | null;
        pendingInstallation: { accountLogin: string } | null;
      };
      expect(fresh.memberships).toHaveLength(0);
      expect(fresh.installUrl).toBe('https://github.com/apps/winnowl/installations/new');
      expect(fresh.pendingInstallation).toBeNull();

      await db
        .insertInto('pending_installations')
        .values({
          id: uuidv7(),
          provider: 'github',
          installation_native_id: '55555',
          account_login: 'gt610-org',
          installer_provider_user_id: '79314033',
          installer_login: 'GT-610',
          status: 'pending',
          decided_by: null,
          decided_at: null,
          created_at: new Date(),
        })
        .execute();
      const waiting = (await newcomer.inject({ method: 'GET', url: '/v1/me' })).json() as {
        pendingInstallation: { accountLogin: string } | null;
      };
      expect(waiting.pendingInstallation?.accountLogin).toBe('gt610-org');
      // Someone else's pending installation is not this user's (keyed by installer).
      const other = await build({
        role: 'viewer',
        scopes: [],
        identity: { provider: 'github', issuer: 'https://github.com', subject: '11111' },
      });
      await other.ready();
      expect(
        (
          (await other.inject({ method: 'GET', url: '/v1/me' })).json() as {
            pendingInstallation: unknown;
          }
        ).pendingInstallation,
      ).toBeNull();
      await other.close();
      expect(
        (
          (await admin.inject({ method: 'GET', url: '/v1/me' })).json() as {
            pendingInstallation: unknown;
          }
        ).pendingInstallation,
      ).toBeNull();
    } finally {
      await newcomer.close();
      if (prevSlug === undefined) delete process.env.GITHUB_APP_SLUG;
      else process.env.GITHUB_APP_SLUG = prevSlug;
    }
  });

  it('/v1/subscription:计划 + 本月用量(viewer 亦可读 plan:read)', async () => {
    const res = await memberApp.inject({ method: 'GET', url: '/v1/subscription' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plan: { key: string };
      usage: { reviews: number; tokens: number };
      withinQuota: boolean;
    };
    expect(body.plan.key).toBeTruthy(); // no subscription -> seeded free / FREE_PLAN
    expect(body.usage.reviews).toBe(1);
    expect(body.usage.tokens).toBe(150);
    expect(body.withinQuota).toBe(true);
  });

  it('/v1/dashboard: 30-day funnel, open findings by severity, recent published', async () => {
    const res = await memberApp.inject({ method: 'GET', url: '/v1/dashboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reviews).toBe(1);
    expect(body.activeRepositories).toBe(1);
    expect(body.funnel).toEqual({ candidates: 3, verified: 3, published: 2, fixed: 1 });
    expect(body.openBySeverity).toEqual([{ severity: 'high', count: 1 }]);
    expect(body.recentPublished.map((f: { claim: string }) => f.claim)).toEqual(['open one']);
    expect(body.recentPublished[0]).toMatchObject({ path: 'a.ts', line: 3, changeNumber: 7 });
  });

  it('/v1/usage 收紧(ADR-014 D5):member 403,admin 200', async () => {
    const denied = await memberApp.inject({ method: 'GET', url: '/v1/usage' });
    expect(denied.statusCode).toBe(403);
    const ok = await admin.inject({ method: 'GET', url: '/v1/usage' });
    expect(ok.statusCode).toBe(200);
  });

  it('/v1/runners:租户只见自有池,operator 才见共享池(D5)', async () => {
    const tenantView = await admin.inject({ method: 'GET', url: '/v1/runners' });
    expect(tenantView.statusCode).toBe(200);
    const tPools = [
      ...new Set((tenantView.json() as { items: { pool: string }[] }).items.map((w) => w.pool)),
    ];
    expect(tPools).toEqual(['acme-pool']);
    const opView = await operator.inject({ method: 'GET', url: '/v1/runners' });
    const oPools = [
      ...new Set((opView.json() as { items: { pool: string }[] }).items.map((w) => w.pool)),
    ];
    expect(oPools.sort()).toEqual(['acme-pool', 'beta-pool', 'shared-pool']);
  });

  it('/v1/notifications:非法分页参数回退为有界默认值', async () => {
    const response = await admin.inject({
      method: 'GET',
      url: '/v1/notifications?limit=not-a-number&offset=NaN',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [], total: 0, unread: 0 });
  });
});
