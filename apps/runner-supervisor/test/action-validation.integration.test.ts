import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionPlan } from '@reviewbot/actions';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { RepositoryPermission } from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { validateActionPlanExecution } from '../src/action-validation.js';

/**
 * Execution-time re-validation uses the approval channel's criterion: console approvals check tenant
 * membership, `@bot approve` in a PR thread checks provider write permission.
 */
const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const CONV = uuidv7();
const USER = uuidv7();
const HOST_URL = 'https://github.com';

describe('ActionPlan 执行期重验(§27.2 / §8.2)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let conv: string;

  const plan = (over: Partial<ActionPlan> = {}): ActionPlan => ({
    id: uuidv7(),
    conversationId: conv,
    actorId: 'winnowl-auto',
    approvalActor: 'any-authorized',
    actions: [{ type: 'create-issue', description: 'track it' }],
    requiredPermissions: ['action:approve'],
    expiresAt: Date.now() + 60 * 60_000,
    status: 'approved',
    ...over,
  });

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('provider_hosts')
      .values({
        id: HOST,
        tenant_id: TENANT,
        provider: 'github',
        base_url: HOST_URL,
        api_url: 'https://api.github.com',
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
        native_id: '900',
        namespace: 'acme',
        name: 'app',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('change_requests')
      .values({
        id: CR,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '42',
        number: 42,
        kind: 'pull-request',
        state: 'open',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    conv = CONV;
    await db
      .insertInto('conversations')
      .values({
        id: CONV,
        tenant_id: TENANT,
        target_kind: 'change-request',
        target_native_id: '42',
        state: 'active',
        context_revision_sha: null,
        summary: '',
        active_task_id: null,
        repository_id: REPO,
        change_request_id: CR,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('users')
      .values({ id: USER, email: 'maintainer@example.com', created_at: new Date() })
      .execute();
    await db
      .insertInto('memberships')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        user_id: USER,
        role: 'admin',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('user_identities')
      .values({
        id: uuidv7(),
        user_id: USER,
        kind: 'provider',
        issuer: HOST_URL,
        subject: '4711',
        login: 'octocat',
        tenant_id: TENANT,
        provider: 'github',
        created_at: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  const withPermission =
    (permission: RepositoryPermission) =>
    async (): Promise<RepositoryPermission> =>
      permission;

  it('console 批准:按租户成员资格重验 —— 有成员资格 → 放行', async () => {
    const result = await validateActionPlanExecution(
      db,
      TENANT,
      plan({ approvedByActorId: '4711', approval: { source: 'console', actorId: '4711' } }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('console 批准:没有成员资格 → 拒绝', async () => {
    const result = await validateActionPlanExecution(
      db,
      TENANT,
      plan({ approvedByActorId: '9999', approval: { source: 'console', actorId: '9999' } }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'actor permission invalid' });
  });

  it('评论批准(没登录过 console)→ 按 provider 的仓库写权限重验', async () => {
    const approvedByComment = plan({
      approvedByActorId: '4711',
      approval: {
        source: 'provider-comment',
        actorId: '4711',
        login: 'octocat',
        host: HOST_URL,
      },
    });
    // The commenter never linked a platform account: membership would deny, write permission allows.
    await db.deleteFrom('user_identities').where('user_id', '=', USER).execute();
    try {
      expect(
        await validateActionPlanExecution(db, TENANT, approvedByComment, {
          resolveActorPermission: withPermission('write'),
        }),
      ).toEqual({ ok: true });
      expect(
        await validateActionPlanExecution(db, TENANT, approvedByComment, {
          resolveActorPermission: withPermission('read'),
        }),
      ).toMatchObject({ ok: false, reason: 'approving actor lost write access' });
      // A failed permission lookup counts as no permission.
      expect(
        await validateActionPlanExecution(db, TENANT, approvedByComment, {
          resolveActorPermission: withPermission('none'),
        }),
      ).toMatchObject({ ok: false, reason: 'approving actor lost write access' });
      expect(
        await validateActionPlanExecution(db, TENANT, approvedByComment, {}).catch(() => ({
          ok: false,
        })),
      ).toMatchObject({ ok: false });
    } finally {
      await db
        .insertInto('user_identities')
        .values({
          id: uuidv7(),
          user_id: USER,
          kind: 'provider',
          issuer: HOST_URL,
          subject: '4711',
          login: 'octocat',
          tenant_id: TENANT,
          provider: 'github',
          created_at: new Date(),
        })
        .execute();
    }
  });

  it('评论批准必须属于当前这台 forge(actor id 在 forge 之间会撞车)', async () => {
    const result = await validateActionPlanExecution(
      db,
      TENANT,
      plan({
        approvedByActorId: '4711',
        approval: {
          source: 'provider-comment',
          actorId: '4711',
          login: 'octocat',
          host: 'https://gitlab.example',
        },
      }),
      { resolveActorPermission: withPermission('admin') },
    );
    expect(result).toMatchObject({ ok: false, reason: 'approval host mismatch' });
  });
});
