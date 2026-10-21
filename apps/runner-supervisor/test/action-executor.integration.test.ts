import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActionPlan, type ActionPlan, type PlannedAction } from '@reviewbot/actions';
import { insertConversation, newConversation } from '@reviewbot/conversation';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createActionExecutor } from '../src/action-executor.js';
import { createActionExecuteHandler } from '../src/action-execute.js';
import { Supervisor } from '../src/supervisor.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const CONV = uuidv7();
const noopSandbox = { create: async () => ({ id: 's', containerId: 'c' }), exec: async () => { throw new Error('x'); }, putFile: async () => undefined, getArtifact: async () => ({ path: '', content: '', bytes: 0 }), destroy: async () => undefined } as unknown as SandboxBackend;

interface Recorded {
  comments: { number: number; markdown: string; key: string }[];
  issues: { title: string; markdown: string; key: string }[];
}

function fakeProvider(rec: Recorded): SourceControlProvider {
  return {
    discussions: {
      createTopLevelComment: async (target: { ref: { number: number } }, body: { markdown: string }, idem: { key: string }) => {
        rec.comments.push({ number: target.ref.number, markdown: body.markdown, key: idem.key });
        return { nativeId: 'c1' };
      },
    },
    issues: {
      create: async (_repo: unknown, input: { title: string; body: { markdown: string } }, idem: { key: string }) => {
        rec.issues.push({ title: input.title, markdown: input.body.markdown, key: idem.key });
        return { ref: { id: uuidv7(), repositoryId: REPO, nativeId: '7', number: 7 }, url: 'x' };
      },
    },
  } as unknown as SourceControlProvider;
}

function plan(id: string, actions: ActionPlan['actions']): ActionPlan {
  return { id, conversationId: CONV, actorId: 'alice', actions, requiredPermissions: [], expiresAt: 4_000_000_000_000, status: 'approved' };
}

describe('action executor', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let workerId: string;
  const rec: Recorded = { comments: [], issues: [] };

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    await db.insertInto('change_requests').values({ id: CR, tenant_id: TENANT, repository_id: REPO, native_id: '42', number: 42, kind: 'pull-request', source_branch: 'feat', target_branch: 'main', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() }).execute();
    // Fixed ids so the plan can reference the internal CR/repository.
    await insertConversation(db, { ...newConversation({ tenantId: TENANT, target: { kind: 'change-request', nativeId: '42' }, repositoryId: REPO, changeRequestId: CR }), id: CONV });
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  });

  afterAll(async () => {
    await stop?.();
  });

  function supervisor(deliverStackedFix?: (action: PlannedAction) => Promise<void>, deliverIssueCr?: (action: PlannedAction) => Promise<void>): Supervisor {
    const handler = createActionExecuteHandler({
      validatePlan: async () => ({ ok: true }),
      executeAction: createActionExecutor({ buildProvider: async () => fakeProvider(rec), ...(deliverStackedFix ? { deliverStackedFix } : {}), ...(deliverIssueCr ? { deliverIssueCr } : {}) }),
    });
    return new Supervisor({ db, sandbox: noopSandbox, workerId, handlers: { action_execute: handler } });
  }

  async function status(id: string): Promise<string> {
    return (await db.selectFrom('action_plans').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
  }

  it('reply + create-issue → 发布评论/Issue,置 executed,幂等键带 plan+序号', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, [
      { type: 'reply', description: '这里是解释。' },
      { type: 'create-issue', description: 'Track leak\n详细描述在此。' },
    ]));
    await enqueueJob(db, { tenantId: TENANT, type: 'action_execute', payload: { tenantId: TENANT, planId: id }, dedupeKey: `ax-${id}` });
    rec.comments.length = 0;
    rec.issues.length = 0;
    await supervisor().runOnce();

    expect(rec.comments).toEqual([{ number: 42, markdown: '这里是解释。', key: `action:${id}:0` }]);
    expect(rec.issues).toEqual([{ title: 'Track leak', markdown: 'Track leak\n详细描述在此。', key: `action:${id}:1` }]);
    expect(await status(id)).toBe('executed');
  });

  it('未接线动作(create-stacked-pr)→ job 失败,不置 executed', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, [{ type: 'create-stacked-pr', description: 'stack it' }]));
    const { jobId } = await enqueueJob(db, { tenantId: TENANT, type: 'action_execute', payload: { tenantId: TENANT, planId: id }, maxAttempts: 1, dedupeKey: `ax2-${id}` });
    await supervisor().runOnce();
    expect(await status(id)).toBe('failed');
    expect((await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status).toBe('failed');
  });

  it('create-stacked-pr → 调用 deliverStackedFix(带 findingIds),置 executed', async () => {
    const calls: PlannedAction[] = [];
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, [{ type: 'create-stacked-pr', description: 'fix bugs', findingIds: ['f1', 'f2'] }]));
    await enqueueJob(db, { tenantId: TENANT, type: 'action_execute', payload: { tenantId: TENANT, planId: id }, dedupeKey: `ax4-${id}` });
    await supervisor(async (action) => { calls.push(action); }).runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe('create-stacked-pr');
    expect(calls[0]!.findingIds).toEqual(['f1', 'f2']);
    expect(await status(id)).toBe('executed');
  });

  it('create-cr-from-issue 未接线 → job 失败,不置 executed', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, [{ type: 'create-cr-from-issue', description: 'implement #8', issueNumber: 8 }]));
    const { jobId } = await enqueueJob(db, { tenantId: TENANT, type: 'action_execute', payload: { tenantId: TENANT, planId: id }, maxAttempts: 1, dedupeKey: `ax5-${id}` });
    await supervisor().runOnce();
    expect(await status(id)).toBe('failed');
    expect((await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status).toBe('failed');
  });

  it('create-cr-from-issue → 调用 deliverIssueCr(带 issueNumber),置 executed', async () => {
    const calls: PlannedAction[] = [];
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, [{ type: 'create-cr-from-issue', description: 'implement #8', issueNumber: 8 }]));
    await enqueueJob(db, { tenantId: TENANT, type: 'action_execute', payload: { tenantId: TENANT, planId: id }, dedupeKey: `ax6-${id}` });
    await supervisor(undefined, async (action) => { calls.push(action); }).runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe('create-cr-from-issue');
    expect(calls[0]!.issueNumber).toBe(8);
    expect(await status(id)).toBe('executed');
  });

  it('plan-issue(read-only)→ 不建 Issue,job 失败(不误派发到 issues.create)', async () => {
    const id = uuidv7();
    await insertActionPlan(db, TENANT, plan(id, [{ type: 'plan-issue', description: 'plan it' }]));
    const { jobId } = await enqueueJob(db, { tenantId: TENANT, type: 'action_execute', payload: { tenantId: TENANT, planId: id }, maxAttempts: 1, dedupeKey: `ax3-${id}` });
    rec.issues.length = 0;
    await supervisor().runOnce();
    expect(rec.issues).toHaveLength(0);
    expect(await status(id)).toBe('failed');
    expect((await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()).status).toBe('failed');
  });
});
