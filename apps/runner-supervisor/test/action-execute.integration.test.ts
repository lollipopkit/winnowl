import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActionPlan, type ActionPlan, type PlannedAction } from '@reviewbot/actions';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createActionExecuteHandler } from '../src/action-execute.js';
import { Supervisor } from '../src/supervisor.js';

const TENANT = uuidv7();
const CONVERSATION = uuidv7();
const noopSandbox = {
  create: async () => ({ id: 's', containerId: 'c' }),
  exec: async () => {
    throw new Error('x');
  },
  putFile: async () => undefined,
  getArtifact: async () => ({ path: '', content: '', bytes: 0 }),
  destroy: async () => undefined,
} as unknown as SandboxBackend;

function plan(id: string, status: ActionPlan['status']): ActionPlan {
  return {
    id,
    conversationId: CONVERSATION,
    actorId: 'alice',
    actions: [{ type: 'create-issue', description: 'file it' }],
    requiredPermissions: [],
    expiresAt: 4_000_000_000_000,
    status,
  };
}

describe('action_execute handler', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let workerId: string;
  let secondWorkerId: string;
  const executed: PlannedAction[] = [];

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('conversations')
      .values({
        id: CONVERSATION,
        tenant_id: TENANT,
        target_kind: 'change-request',
        target_native_id: '1',
        state: 'active',
        context_revision_sha: null,
        summary: '',
        active_task_id: null,
        repository_id: null,
        change_request_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
    secondWorkerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  });

  afterAll(async () => {
    await stop?.();
  });

  function supervisor(): Supervisor {
    const handler = createActionExecuteHandler({
      validatePlan: async () => ({ ok: true }),
      executeAction: async (action) => {
        executed.push(action);
      },
    });
    return new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { action_execute: handler },
    });
  }

  async function status(id: string): Promise<string> {
    return (
      await db
        .selectFrom('action_plans')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;
  }

  it('approved plan → 执行动作并置 executed', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, 'approved'));
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: { tenantId: TENANT, planId: id },
      dedupeKey: `ax-${id}`,
    });
    executed.length = 0;
    await supervisor().runOnce();
    expect(executed.map((a) => a.type)).toEqual(['create-issue']);
    expect(await status(id)).toBe('executed');
    expect(
      (
        await db
          .selectFrom('jobs')
          .select('status')
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('completed');
  });

  it('未批准 plan → job 失败,不执行', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, 'proposed'));
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: { tenantId: TENANT, planId: id },
      maxAttempts: 1,
      dedupeKey: `ax2-${id}`,
    });
    executed.length = 0;
    await supervisor().runOnce();
    expect(executed).toHaveLength(0);
    expect(await status(id)).toBe('proposed');
    expect(
      (
        await db
          .selectFrom('jobs')
          .select('status')
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('failed');
  });

  it('并发 action_execute 只有一个能原子领取并执行 approved plan', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, 'approved'));
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: { tenantId: TENANT, planId: id },
      dedupeKey: `ax-concurrent-a-${id}`,
    });
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: { tenantId: TENANT, planId: id },
      dedupeKey: `ax-concurrent-b-${id}`,
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const handler = createActionExecuteHandler({
      validatePlan: async () => ({ ok: true }),
      executeAction: async () => {
        calls += 1;
        await gate;
      },
    });
    const first = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { action_execute: handler },
    }).runOnce();
    const deadline = Date.now() + 5_000;
    while (calls === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);

    await new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId: secondWorkerId,
      handlers: { action_execute: handler },
    }).runOnce();
    expect(calls).toBe(1);
    release();
    await first;
    expect(await status(id)).toBe('executed');
  });

  it('execution-time validation rejects a stale approved plan before side effects', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, 'approved'));
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: { tenantId: TENANT, planId: id },
      maxAttempts: 1,
      dedupeKey: `ax-stale-${id}`,
    });
    let calls = 0;
    const handler = createActionExecuteHandler({
      validatePlan: async () => ({ ok: false, reason: 'head changed' }),
      executeAction: async () => {
        calls += 1;
      },
    });
    await new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { action_execute: handler },
    }).runOnce();
    expect(calls).toBe(0);
    // A validation veto clears the approver, so a different approver can re-approve and rerun.
    expect(
      await db
        .selectFrom('action_plans')
        .select(['status', 'approved_by_actor_id', 'approval_provenance'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      status: 'approved',
      approved_by_actor_id: null,
      approval_provenance: null,
    });
    expect(
      await db
        .selectFrom('jobs')
        .select('status')
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'failed' });
  });

  it('校验否决也给用户回执(别让他对着 PR 干等)', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, 'approved'));
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: { tenantId: TENANT, planId: id },
      maxAttempts: 1,
      dedupeKey: `ax-stale-report-${id}`,
    });
    const reported: string[] = [];
    const handler = createActionExecuteHandler({
      validatePlan: async () => ({ ok: false, reason: 'head changed' }),
      executeAction: async () => undefined,
      onTerminalFailure: async ({ plan }) => {
        reported.push(plan.id);
      },
    });
    await new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { action_execute: handler },
    }).runOnce();
    expect(reported).toEqual([id]);
  });

  it('终态失败落到计划上,并给用户回执(不再静默留在 approved)', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, 'approved'));
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: { tenantId: TENANT, planId: id },
      maxAttempts: 1,
      dedupeKey: `ax-terminal-${id}`,
    });
    const reported: string[] = [];
    const handler = createActionExecuteHandler({
      validatePlan: async () => ({ ok: true }),
      executeAction: async () => {
        throw new Error('provider is down for good');
      },
      onTerminalFailure: async ({ plan }) => {
        reported.push(plan.id);
      },
    });
    await new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { action_execute: handler },
    }).runOnce();
    expect(reported).toEqual([id]);
    expect(await status(id)).toBe('failed');
  });
});
