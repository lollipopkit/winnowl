import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActionPlan, newActionPlan } from '@reviewbot/actions';
import { resolveModelSourceFromEnv } from '@reviewbot/agent-pi';
import { insertConversation, newConversation } from '@reviewbot/conversation';
import { createDb, type Db } from '@reviewbot/db';
import type { RepositoryRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import { GithubProvider } from '@reviewbot/provider-github';
import { RestClient } from '@reviewbot/provider-http';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createActionExecutor } from '../src/action-executor.js';
import { createActionExecuteHandler } from '../src/action-execute.js';
import { createConversationRoute } from '../src/conversation-route.js';
import { createIssueEnrichHandler } from '../src/issue-enrich.js';
import { Supervisor } from '../src/supervisor.js';

const token = process.env.REVIEWBOT_LIVE_GITHUB_TOKEN;
const repoSlug = process.env.REVIEWBOT_LIVE_GITHUB_REPO;
const issueForEnrich = process.env.REVIEWBOT_LIVE_GITHUB_ISSUE;
const baseUrl = process.env.REVIEWBOT_LIVE_GITHUB_API ?? 'https://api.github.com';
const [owner, name] = (repoSlug ?? '/').split('/');

const writeEnabled = Boolean(token && repoSlug); // creating issues needs no LLM
const enrichEnabled = Boolean(
  token && repoSlug && issueForEnrich && process.env.LLM_LIVE && process.env.LLM_MODEL,
);

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const CONV = uuidv7();
const noopSandbox = {
  create: async () => ({ id: 's', containerId: 'c' }),
  exec: async () => {
    throw new Error('x');
  },
  putFile: async () => undefined,
  getArtifact: async () => ({ path: '', content: '', bytes: 0 }),
  destroy: async () => undefined,
} as unknown as SandboxBackend;

function provider(): GithubProvider {
  return new GithubProvider({
    client: new RestClient({ baseUrl, authorization: () => `token ${token}` }),
    host: { id: 'live', provider: 'github', baseUrl, apiUrl: baseUrl, isSaas: true },
    resolveRepo: () => ({ owner: owner ?? '', repo: name ?? '' }),
  });
}

const repoRef: RepositoryRef = {
  id: REPO,
  providerHostId: HOST,
  installationId: INSTALL,
  nativeId: 'live',
  namespace: owner ?? '',
  name: name ?? '',
  cloneUrl: `https://github.com/${repoSlug}.git`,
  defaultBranch: 'main',
};

describe.skipIf(!writeEnabled)('M7 交互链 live:create-issue ActionPlan → 真实建 issue', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let workerId: string;

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
        base_url: 'x',
        api_url: baseUrl,
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
        account_login: owner ?? 'x',
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
        native_id: 'live',
        namespace: owner ?? '',
        name: name ?? '',
        clone_url: repoRef.cloneUrl,
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
        native_id: 'live',
        number: 1,
        kind: 'pull-request',
        source_branch: 'feature/mul',
        target_branch: 'main',
        state: 'open',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await insertConversation(db, {
      ...newConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: 'live' },
        repositoryId: REPO,
        changeRequestId: CR,
      }),
      id: CONV,
    });
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  });

  afterAll(async () => {
    await stop?.();
  });

  it('approved create-issue plan → action-executor 在真实 repo 建 issue', async () => {
    const title = `winnowl action-executor smoke ${Date.now()}`;
    const plan = newActionPlan({
      conversationId: CONV,
      actorId: 'live',
      actions: [{ type: 'create-issue', description: title }],
      requiredPermissions: [],
    });
    await insertActionPlan(db, TENANT, { ...plan, status: 'approved' });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'action_execute',
      payload: { tenantId: TENANT, planId: plan.id },
      dedupeKey: `ax-${plan.id}`,
    });

    const handler = createActionExecuteHandler({
      validatePlan: async () => ({ ok: true }),
      executeAction: createActionExecutor({ buildProvider: async () => provider() }),
    });
    await new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { action_execute: handler },
    }).runOnce();

    const status = (
      await db
        .selectFrom('action_plans')
        .select('status')
        .where('id', '=', plan.id)
        .executeTakeFirstOrThrow()
    ).status;
    expect(status).toBe('executed'); // executed proves provider.issues.create succeeded
    const jobStatus = (
      await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()
    ).status;
    expect(jobStatus).toBe('completed');
    console.log('[live-scenario] created issue via action-executor, title:', title);
  }, 60_000);

  it('conversation route:create-issue 意图 → 提议 proposed plan(bound to CR)', async () => {
    const replies: string[] = [];
    const route = createConversationRoute({
      reply: async (_p, text) => {
        replies.push(text);
      },
    });
    await route({
      intent: { intent: 'create-issue', argument: 'live: track flaky test', source: 'command' },
      conversation: { id: CONV } as never,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: 'live' },
        actorLogin: 'alice',
        actorId: 'gh-1',
        body: '@winnowl create issue live: track flaky test',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    const plan = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('conversation_id', '=', CONV)
      .where('status', '=', 'proposed')
      .executeTakeFirst();
    expect(plan).toBeTruthy();
    expect(replies[0]).toContain('确认');
  });
});

describe.skipIf(!enrichEnabled)('M8 issue_enrich live:真实 issue → 真实 LLM enrich 评论', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let workerId: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  });

  afterAll(async () => {
    await stop?.();
  });

  it('issue_enrich(mode enrich)→ 读真实 issue → LLM → 发布分诊评论', async () => {
    const source = resolveModelSourceFromEnv();
    if (!source) throw new Error('no model source');
    const p = provider();
    const issueRef = {
      id: 'live',
      repositoryId: REPO,
      nativeId: 'live',
      number: Number(issueForEnrich),
    } as const;
    const before =
      (await p.discussions.listTopLevelComments?.({ kind: 'issue', ref: issueRef })) ?? [];
    const beforeIds = new Set(before.map((comment) => comment.nativeId));
    const handler = createIssueEnrichHandler({
      buildEnv: async () => ({
        provider: p,
        repo: repoRef,
        model: source.model,
        streamFn: source.streamFn,
      }),
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'issue_enrich',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        issueNativeId: 'live',
        issueNumber: Number(issueForEnrich),
        mode: 'enrich',
      },
      dedupeKey: `ie-${Date.now()}`,
    });
    await new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { issue_enrich: handler },
    }).runOnce();
    const jobStatus = (
      await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()
    ).status;
    expect(jobStatus).toBe('completed');
    const after =
      (await p.discussions.listTopLevelComments?.({ kind: 'issue', ref: issueRef })) ?? [];
    const published = after.find((comment) => !beforeIds.has(comment.nativeId));
    expect(published, 'issue enrichment must publish a new provider comment').toBeTruthy();
    expect(published?.body).toMatch(/Issue triage|Issue 分诊|Issue 分診/);
    console.log(
      '[live-scenario] issue_enrich published enrichment comment on issue',
      issueForEnrich,
    );
  }, 120_000);
});
