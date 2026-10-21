import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActionPlan, type ActionPlan } from '@reviewbot/actions';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const TENANT = uuidv7();
const CONV = uuidv7();
const HOST = uuidv7();
const INSTALLATION = uuidv7();
const REPOSITORY = uuidv7();
const CHANGE_REQUEST = uuidv7();
const REVISION = uuidv7();

function makePlan(id: string): ActionPlan {
  return {
    id,
    conversationId: CONV,
    actorId: 'alice',
    revisionSha: 'head-1',
    actions: [{ type: 'create-stacked-pr', description: 'fix' }],
    requiredPermissions: ['action:approve'],
    expiresAt: 4_000_000_000_000,
    status: 'proposed',
  };
}

describe('control-api ActionPlan 审批端点', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let app: FastifyInstance;

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
        base_url: 'https://github.com',
        api_url: 'https://api.github.com',
        is_saas: true,
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('installations')
      .values({
        id: INSTALLATION,
        tenant_id: TENANT,
        provider_host_id: HOST,
        native_id: 'i1',
        account_login: 'acme',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('repositories')
      .values({
        id: REPOSITORY,
        tenant_id: TENANT,
        provider_host_id: HOST,
        installation_id: INSTALLATION,
        native_id: 'r1',
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
        id: CHANGE_REQUEST,
        tenant_id: TENANT,
        repository_id: REPOSITORY,
        native_id: '1',
        number: 1,
        kind: 'pull-request',
        source_branch: 'feat',
        target_branch: 'main',
        state: 'open',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values({
        id: REVISION,
        tenant_id: TENANT,
        change_request_id: CHANGE_REQUEST,
        base_sha: 'base',
        head_sha: 'head-1',
        merge_base_sha: null,
        source_branch: 'feat',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('conversations')
      .values({
        id: CONV,
        tenant_id: TENANT,
        target_kind: 'change-request',
        target_native_id: '1',
        state: 'active',
        context_revision_sha: 'head-1',
        summary: '',
        active_task_id: null,
        repository_id: REPOSITORY,
        change_request_id: CHANGE_REQUEST,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    // alice = admin (has action:approve), bob = member (does not)
    app = await buildServer({
      quiet: true,
      db,
      rbac: {
        resolveAuth: () => ({
          role: 'admin',
          scopes: ['admin'],
          tenantId: TENANT,
          actorId: 'alice',
        }),
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await stop?.();
  });

  it('匹配确认 → 200 approved 并入队 action_execute', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, makePlan(id));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/action-plans/${id}/confirm`,
      payload: { conversationId: CONV },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'approved' });
    // Approval enqueues action_execute in the same transaction.
    const job = await db
      .selectFrom('jobs')
      .select(['type', 'payload'])
      .where('tenant_id', '=', TENANT)
      .where('dedupe_key', '=', `action-execute:${id}`)
      .executeTakeFirst();
    expect(job?.type).toBe('action_execute');
    expect(job?.payload).toMatchObject({ planId: id, tenantId: TENANT });
  });

  it('Head 变化 → 409', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, makePlan(id));
    await db
      .updateTable('revisions')
      .set({ head_sha: 'head-2' })
      .where('id', '=', REVISION)
      .execute();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/action-plans/${id}/confirm`,
        payload: { conversationId: CONV },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ reason: 'head changed' });
    } finally {
      await db
        .updateTable('revisions')
        .set({ head_sha: 'head-1' })
        .where('id', '=', REVISION)
        .execute();
    }
  });

  it('非本人 Actor(auth actorId=alice,plan.actorId=carol)→ 409', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, { ...makePlan(id), actorId: 'carol' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/action-plans/${id}/confirm`,
      payload: { conversationId: CONV },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'actor mismatch' });
  });

  it('无 action:approve 权限 → 403', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, makePlan(id));
    const viewer = await buildServer({
      quiet: true,
      db,
      rbac: {
        resolveAuth: () => ({ role: 'member', scopes: [], tenantId: TENANT, actorId: 'alice' }),
      },
    });
    await viewer.ready();
    const res = await viewer.inject({
      method: 'POST',
      url: `/v1/action-plans/${id}/confirm`,
      payload: { conversationId: CONV },
    });
    expect(res.statusCode).toBe(403);
    await viewer.close();
  });

  it('GET /v1/action-plans 列出', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/action-plans' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBeGreaterThan(0);
  });

  it('GET /v1/action-plans/:id/commands lists the sandbox commands of the plan, oldest first, this tenant only', async () => {
    const plan = uuidv7();
    const row = (command: string, verdict: 'allow' | 'deny', at: number, tenant = TENANT) => ({
      id: uuidv7(),
      tenant_id: tenant,
      job_id: plan,
      command,
      verdict,
      decided_by: 'rule' as const,
      rule: verdict === 'allow' ? 'toolchain' : 'publish:npm',
      reason: verdict === 'allow' ? 'routine command' : 'no publishing',
      created_at: new Date(at),
      ...(verdict === 'allow' ? { exit_code: 0, duration_ms: 1500, timed_out: false, oom_killed: false } : {}),
    });
    await db
      .insertInto('agent_commands')
      .values([row('npm test', 'allow', 2000), row('npm publish', 'deny', 1000), row('other tenant', 'allow', 3000, uuidv7())])
      .execute();
    const res = await app.inject({ method: 'GET', url: `/v1/action-plans/${plan}/commands` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { commands: unknown[] }).commands).toMatchObject([
      { command: 'npm publish', verdict: 'deny', rule: 'publish:npm' },
      { command: 'npm test', verdict: 'allow', exitCode: 0, durationMs: 1500 },
    ]);
    expect((res.json() as { commands: unknown[] }).commands).toHaveLength(2);
    expect((await app.inject({ method: 'GET', url: '/v1/action-plans/x/commands' })).statusCode).toBe(404);
  });
});
