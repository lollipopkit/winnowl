import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMANDS,
  findConversationByTarget,
  insertConversation,
  loadConversation,
  newConversation,
  listMessages,
  type Conversation,
} from '@reviewbot/conversation';
import { createDb, type Db } from '@reviewbot/db';
import {
  dismissFindingForChangeRequest,
  loadChangeRequestBlockingFindings,
  loadDismissedFindings,
} from '@reviewbot/finding-lifecycle';
import { uuidv7 } from '@reviewbot/ids';
import { ensureRunnerPool, enqueueJob, registerWorker, reviewDedupeKey } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { loadEffectiveConfig, persistEffectiveConfig } from '@reviewbot/review-runtime';
import type { RepositoryPermission, SourceControlProvider } from '@reviewbot/provider-contracts';
import { createConversationTurnHandler, type ConversationRouteContext } from '../src/conversation-turn.js';
import { createConversationRoute } from '../src/conversation-route.js';
import { createChangeRequestRegistrar } from '../src/change-request-registry.js';
import { createConversationReply } from '../src/reply.js';
import { Supervisor } from '../src/supervisor.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();
const noopSandbox = {
  create: async () => ({ id: 's', containerId: 'c' }),
  exec: async () => {
    throw new Error('x');
  },
  putFile: async () => undefined,
  getArtifact: async () => ({ path: '', content: '', bytes: 0 }),
  destroy: async () => undefined,
} as unknown as SandboxBackend;

describe('conversation_turn handler', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let workerId: string;
  const routed: ConversationRouteContext[] = [];
  const transientConversationIds: string[] = [];

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
        native_id: '900',
        namespace: 'acme',
        name: 'app',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    // The author columns drive authorization for ignore/pause.
    await db
      .insertInto('change_requests')
      .values({
        id: CR,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '42',
        number: 42,
        kind: 'pull-request',
        source_branch: 'feat',
        target_branch: 'main',
        state: 'open',
        draft: false,
        author: 'alice',
        author_provider_id: 'gh-author',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values({
        id: REV,
        tenant_id: TENANT,
        change_request_id: CR,
        base_sha: 'base',
        head_sha: 'head-1',
        merge_base_sha: null,
        source_branch: 'feat',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    // A full default config with language zh: loadEffectiveConfig does not fill defaults,
    // so a partial config would crash the handler.
    const baseCfg = await loadEffectiveConfig(db, TENANT, REPO);
    await persistEffectiveConfig(db, {
      tenantId: TENANT,
      repositoryId: REPO,
      settings: { ...baseCfg, language: 'zh' },
      configDigest: 'lang-zh',
    });
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  });

  afterAll(async () => {
    await stop?.();
  });

  afterEach(async () => {
    while (transientConversationIds.length > 0) {
      const id = transientConversationIds.pop()!;
      await db.deleteFrom('action_plans').where('conversation_id', '=', id).execute();
      await db.deleteFrom('conversation_messages').where('conversation_id', '=', id).execute();
      await db.deleteFrom('conversations').where('id', '=', id).execute();
    }
  });

  function transientConversation(input: Parameters<typeof newConversation>[0]): Conversation {
    const id = uuidv7();
    const conversation = {
      ...newConversation({
        ...input,
        // These direct route tests do not need to share the turn-handler's
        // persisted target. Give every fixture a distinct database identity.
        target: { ...input.target, nativeId: `${input.target.nativeId}:${id}` },
      }),
      id,
    };
    transientConversationIds.push(conversation.id);
    return conversation;
  }

  /** Inserts a blocking occurrence of a finding on this CR (fix targets and the gate are CR-scoped). */
  async function blockingOccurrence(findingId: string, revisionId: string = REV): Promise<void> {
    await db
      .insertInto('finding_occurrences')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        finding_id: findingId,
        review_run_id: null,
        revision_id: revisionId,
        state: 'inline',
        severity: 'high',
        change_relation: 'introduced',
        confirmation: 'independently-verified',
        anchor: { path: 'a.ts', line: 3 } as unknown as Record<string, unknown>,
        anchor_text: 'x',
        blocking: true,
        refuter_upheld: true,
        evidence: [] as unknown as unknown[],
        created_at: new Date(),
      })
      .execute();
  }

  function supervisor(): Supervisor {
    const handler = createConversationTurnHandler({
      botName: 'winnowl',
      route: async (ctx) => {
        routed.push(ctx);
      },
    });
    return new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { conversation_turn: handler },
    });
  }

  async function turn(body: string, dedupe: string): Promise<void> {
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        body,
        repositoryId: REPO,
        changeRequestId: CR,
      },
      dedupeKey: dedupe,
    });
    await supervisor().runOnce();
  }

  it('首条消息 → 建会话 + 记消息 + 命令路由', async () => {
    routed.length = 0;
    await turn('@winnowl review', 't1');
    const conv = await findConversationByTarget(db, TENANT, 'change-request', '42', {
      repositoryId: REPO,
      changeRequestId: CR,
    });
    expect(conv).not.toBeNull();
    expect((await listMessages(db, conv!.id)).map((m) => m.body)).toEqual(['@winnowl review']);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.intent).toMatchObject({ intent: 'review', source: 'command' });
  });

  it('同 target 第二条 → 复用会话,追加消息', async () => {
    await turn('@winnowl fix all', 't2');
    const conv = await findConversationByTarget(db, TENANT, 'change-request', '42', {
      repositoryId: REPO,
      changeRequestId: CR,
    });
    expect((await listMessages(db, conv!.id)).map((m) => m.body)).toEqual([
      '@winnowl review',
      '@winnowl fix all',
    ]);
  });

  it('same native target id in another repository does not reuse the conversation', async () => {
    const otherRepositoryId = uuidv7();
    const otherChangeRequestId = uuidv7();
    await db
      .insertInto('repositories')
      .values({
        id: otherRepositoryId,
        tenant_id: TENANT,
        provider_host_id: HOST,
        installation_id: INSTALL,
        native_id: '901',
        namespace: 'acme',
        name: 'other',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('change_requests')
      .values({
        id: otherChangeRequestId,
        tenant_id: TENANT,
        repository_id: otherRepositoryId,
        native_id: '42',
        number: 42,
        kind: 'pull-request',
        state: 'open',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        body: '@winnowl review',
        repositoryId: otherRepositoryId,
        changeRequestId: otherChangeRequestId,
      },
      dedupeKey: 'other-repository',
    });
    await supervisor().runOnce();

    const other = await findConversationByTarget(db, TENANT, 'change-request', '42', {
      repositoryId: otherRepositoryId,
      changeRequestId: otherChangeRequestId,
    });
    const original = await findConversationByTarget(db, TENANT, 'change-request', '42', {
      repositoryId: REPO,
      changeRequestId: CR,
    });
    expect(original?.id).toBeDefined();
    expect(other?.id).toBeDefined();
    expect(other?.id).not.toBe(original?.id);
  });

  it('非命令(无 @mention)→ 记消息但不路由', async () => {
    routed.length = 0;
    await turn('just chatting', 't3');
    expect(routed).toHaveLength(0);
    const conv = await findConversationByTarget(db, TENANT, 'change-request', '42', {
      repositoryId: REPO,
      changeRequestId: CR,
    });
    expect((await listMessages(db, conv!.id)).length).toBe(3);
  });

  it('真实 route:@winnowl review → 入队 review_revision', async () => {
    const handler = createConversationTurnHandler({
      botName: 'winnowl',
      route: createConversationRoute(),
    });
    const sup = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { conversation_turn: handler },
    });
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        body: '@winnowl review',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      dedupeKey: 'route-1',
    });
    await sup.runOnce();
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'review_revision')
      .executeTakeFirst();
    expect(job).toBeTruthy();
    expect((job!.payload as { changeRequestId?: string }).changeRequestId).toBe(CR);
    expect((job!.payload as { headSha?: string }).headSha).toBe('head-1');
  });

  it('同 Head 已有自动 review 时,manual review 使用独立 dedupe key 仍会新建', async () => {
    await db.deleteFrom('jobs').where('type', '=', 'review_revision').execute();
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR,
        revisionId: REV,
        headSha: 'head-1',
        configDigest: '',
      },
      dedupeKey: reviewDedupeKey({
        repositoryId: REPO,
        changeRequestId: CR,
        headSha: 'head-1',
        configDigest: '',
      }),
    });
    const route = createConversationRoute();
    const conversation = {
      ...newConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      }),
      id: uuidv7(),
    };
    await route({
      intent: { intent: 'review', source: 'command' },
      conversation,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        body: '@winnowl review',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    const jobs = await db
      .selectFrom('jobs')
      .select(['dedupe_key', 'payload'])
      .where('type', '=', 'review_revision')
      .execute();
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.dedupe_key)).size).toBe(2);
    expect(jobs.some((job) => (job.payload as { trigger?: string }).trigger === 'manual')).toBe(
      true,
    );
    await db.deleteFrom('jobs').where('type', '=', 'review_revision').execute();
  });

  it('review checkbox: needs write access, then enqueues a manual review and marks the status comment', async () => {
    await db.deleteFrom('jobs').where('type', '=', 'review_revision').execute();
    const calls: string[] = [];
    const permissions: Record<string, 'read' | 'write'> = { reader: 'read', writer: 'write' };
    const route = createConversationRoute({
      resolveActorPermission: async (_repo, actor) => permissions[actor.login] ?? 'none',
      statusComment: {
        requested: async (_t, login) => void calls.push(`requested:${login}`),
        denied: async (_t, login) => void calls.push(`denied:${login}`),
      },
    });
    const conversation = {
      ...newConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      }),
      id: uuidv7(),
    };
    const payload = (actorLogin: string) => ({
      tenantId: TENANT,
      target: { kind: 'change-request' as const, nativeId: '42' },
      actorLogin,
      body: '',
      command: { kind: 'review-checkbox' as const, commentNativeId: '1' },
      repositoryId: REPO,
      changeRequestId: CR,
    });
    const reviewJobs = () => db.selectFrom('jobs').select('payload').where('type', '=', 'review_revision').execute();

    await route({ intent: { intent: 'review', source: 'command' }, conversation, payload: payload('reader'), db });
    expect(await reviewJobs()).toHaveLength(0);
    expect(calls).toEqual(['denied:reader']);

    await route({ intent: { intent: 'review', source: 'command' }, conversation, payload: payload('writer'), db });
    const jobs = await reviewJobs();
    expect(jobs).toHaveLength(1);
    expect((jobs[0]!.payload as { trigger?: string }).trigger).toBe('manual');
    expect(calls).toEqual(['denied:reader', 'requested:writer']);
    await db.deleteFrom('jobs').where('type', '=', 'review_revision').execute();
  });

  it('review / reverify / fix from someone who is neither the author nor a writer is refused', async () => {
    await db.deleteFrom('jobs').where('type', 'in', ['review_revision', 'reverify_findings']).execute();
    const replies: string[] = [];
    const route = createConversationRoute({
      resolveActorPermission: async () => 'read',
      reply: async (_p, text) => void replies.push(text),
    });
    const conversation = {
      ...newConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      }),
      id: uuidv7(),
    };
    const payload = {
      tenantId: TENANT,
      target: { kind: 'change-request' as const, nativeId: '42' },
      actorLogin: 'passer-by',
      actorId: '999999',
      body: '@winnowl review',
      repositoryId: REPO,
      changeRequestId: CR,
    };
    for (const intent of ['review', 'full-review', 'reverify', 'fix-all'] as const) {
      await route({ intent: { intent, source: 'command' }, conversation, payload, db });
    }
    const jobs = await db
      .selectFrom('jobs')
      .select('type')
      .where('type', 'in', ['review_revision', 'reverify_findings'])
      .execute();
    expect(jobs).toHaveLength(0);
    expect(replies).toHaveLength(4);
    expect(await db.selectFrom('action_plans').select('id').where('actor_id', '=', '999999').execute()).toHaveLength(0);
    expect(replies[0]).toContain('admin/maintain/write');
  });

  it('full-review forces whole-PR exploration and has its own dedupe scope', async () => {
    await db.deleteFrom('jobs').where('type', '=', 'review_revision').execute();
    const route = createConversationRoute();
    const conversation = {
      ...newConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      }),
      id: uuidv7(),
    };
    const payload = {
      tenantId: TENANT,
      target: { kind: 'change-request' as const, nativeId: '42' },
      actorLogin: 'alice',
      body: '@winnowl full-review',
      repositoryId: REPO,
      changeRequestId: CR,
    };
    await route({ intent: { intent: 'review', source: 'command' }, conversation, payload, db });
    await route({
      intent: { intent: 'full-review', source: 'command' },
      conversation,
      payload,
      db,
    });
    const jobs = await db
      .selectFrom('jobs')
      .select(['dedupe_key', 'payload'])
      .where('type', '=', 'review_revision')
      .execute();
    expect(jobs).toHaveLength(2);
    const full = jobs.find(
      (job) => (job.payload as { forceFullReview?: boolean }).forceFullReview === true,
    );
    expect(full?.dedupe_key).toContain(':manual:full');
    expect(jobs.find((job) => job !== full)?.dedupe_key).toContain(':manual');
    await db.deleteFrom('jobs').where('type', '=', 'review_revision').execute();
  });

  it('reverify → 入队 reverify_findings(定向重验,非整轮 review)+ 回执(§26.3)', async () => {
    const replies: string[] = [];
    const conv = transientConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      reply: async (_p, t) => {
        replies.push(t);
      },
    });
    await route({
      intent: { intent: 'reverify', source: 'command' },
      conversation: conv,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        body: '@winnowl verify',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    // Directed re-verify: enqueues reverify_findings without rerunning Map/Dig.
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'reverify_findings')
      .executeTakeFirst();
    expect(job).toBeTruthy();
    expect((job!.payload as { changeRequestId?: string }).changeRequestId).toBe(CR);
    expect(replies[0]).toContain('重验');
  });

  it('explain-finding 意图 → 入队 explain_finding(不回执)', async () => {
    const replies: string[] = [];
    const route = createConversationRoute({
      reply: async (_p, text) => {
        replies.push(text);
      },
    });
    await route({
      intent: { intent: 'explain-finding', source: 'command' },
      conversation: {} as never,
      payload: {
        tenantId: TENANT,
        target: { kind: 'review-thread', nativeId: 't1' },
        actorLogin: 'alice',
        body: '@winnowl explain',
        repositoryId: REPO,
        changeRequestId: CR,
        anchorPath: 'src/math.ts',
      },
      db,
    });
    expect(replies).toHaveLength(0); // handled by a job, no inline reply
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'explain_finding')
      .executeTakeFirst();
    expect(job).toBeDefined();
    expect((job!.payload as unknown as { anchorPath: string; targetKind: string }).anchorPath).toBe(
      'src/math.ts',
    );
    expect((job!.payload as unknown as { targetKind: string }).targetKind).toBe('review-thread');
  });

  it('help lists every command from the shared catalog', async () => {
    const replies: string[] = [];
    const route = createConversationRoute({
      reply: async (_p, text) => {
        replies.push(text);
      },
    });
    await route({
      intent: { intent: 'help', source: 'command' },
      conversation: {} as never,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        body: '@winnowl help',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    expect(replies).toHaveLength(1);
    for (const c of COMMANDS) expect(replies[0]).toContain(`@winnowl ${c.usage}`);
  });

  it('create-issue 意图 → 提议 ActionPlan(proposed)+ 会话置 waiting-confirmation + 回执带计划 ID', async () => {
    const replies: string[] = [];
    const conv = transientConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      // Creating an issue writes to the repo: needs author or write permission.
      resolveActorPermission: async () => 'write',
      reply: async (_p, text) => {
        replies.push(text);
      },
      now: () => 1_700_000_000_000,
    });
    await route({
      intent: { intent: 'create-issue', argument: 'memory leak in cache', source: 'command' },
      conversation: conv,
      // The plan stores the provider actor id (not the login) to match auth.actorId at confirmation.
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        actorId: 'gh-user-42',
        body: '@winnowl create issue memory leak in cache',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    const plan = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('conversation_id', '=', conv.id)
      .executeTakeFirst();
    expect(plan?.status).toBe('proposed');
    expect(plan?.actor_id).toBe('gh-user-42');
    // create-issue does not depend on the head, so no revisionSha binding.
    expect(plan?.revision_sha).toBeNull();
    expect((plan!.actions as unknown as { type: string; description: string }[])[0]).toEqual({
      type: 'create-issue',
      description: 'memory leak in cache',
    });
    expect((await loadConversation(db, TENANT, conv.id))!.state).toBe('waiting-confirmation');
    expect(replies[0]).toContain(plan!.id);
    expect(replies[0]).toContain(plan!.id);
  });

  // create-issue / implement-issue get the same write gate as fix: otherwise anyone on a public repo
  // could make the bot open issues, with no execution-time check when require_confirmation=false.
  it('create-issue:没有写权限的人触发 → 不提议,回执说明只限作者/写权限', async () => {
    const replies: string[] = [];
    const conv = transientConversation({
      tenantId: TENANT,
      target: { kind: 'change-request', nativeId: '42' },
      repositoryId: REPO,
      changeRequestId: CR,
    });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      resolveActorPermission: async () => 'read',
      reply: async (_p, text) => {
        replies.push(text);
      },
    });
    await route({
      intent: { intent: 'create-issue', argument: 'memory leak in cache', source: 'command' },
      conversation: conv,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'outsider',
        actorId: 'gh-outsider',
        body: '@winnowl create issue memory leak',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    expect(
      await db
        .selectFrom('action_plans')
        .select('id')
        .where('conversation_id', '=', conv.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('写权限');
  });

  it('implement-issue:没有写权限的人触发 → 不提议(按仓判权,Issue 上没有 CR 可判)', async () => {
    const replies: string[] = [];
    const conv = transientConversation({
      tenantId: TENANT,
      target: { kind: 'issue', nativeId: '321' },
      repositoryId: REPO,
    });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      resolveActorPermission: async () => 'triage',
      reply: async (_p, text) => {
        replies.push(text);
      },
    });
    await route({
      intent: { intent: 'implement-issue', argument: 'add retry', source: 'command' },
      conversation: conv,
      payload: {
        tenantId: TENANT,
        target: { kind: 'issue', nativeId: '321' },
        actorLogin: 'outsider',
        actorId: 'gh-outsider',
        body: '@winnowl implement add retry',
        repositoryId: REPO,
        issueNumber: 8,
      },
      db,
    });
    expect(
      await db
        .selectFrom('action_plans')
        .select('id')
        .where('conversation_id', '=', conv.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('写权限');
  });

  it('actions.create_issue.require_confirmation=false → approved 并原子入队', async () => {
    const settings = {
      language: 'zh',
      actions: { create_issue: { enabled: true, require_confirmation: false } },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'create-issue-preauthorized',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();
    const conv = transientConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      });
    await insertConversation(db, conv);
    const replies: string[] = [];
    const route = createConversationRoute({
      // Creating an issue writes to the repo: needs author or write permission.
      resolveActorPermission: async () => 'write',
      reply: async (_payload, text) => void replies.push(text),
    });
    await route({
      intent: { intent: 'create-issue', argument: 'preauthorized issue', source: 'command' },
      conversation: conv,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        actorId: 'gh-user-42',
        body: '@winnowl create issue preauthorized issue',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    const plan = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('conversation_id', '=', conv.id)
      .executeTakeFirstOrThrow();
    expect(plan.status).toBe('approved');
    expect(plan.required_permissions).toEqual([]);
    expect(
      await db
        .selectFrom('jobs')
        .select('id')
        .where('dedupe_key', '=', `action-execute:${plan.id}`)
        .executeTakeFirst(),
    ).toBeTruthy();
    expect((await loadConversation(db, TENANT, conv.id))!.state).toBe('active');
    expect(replies[0]).toContain(plan.id);
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  it('fix-all 意图 → 提议 create-stacked-pr plan(带 active finding ids)', async () => {
    const FINDING = uuidv7();
    await db
      .insertInto('findings')
      .values({
        id: FINDING,
        tenant_id: TENANT,
        repository_id: REPO,
        semantic_fingerprint: `fp-${FINDING}`,
        category: 'correctness',
        canonical_claim: 'off-by-one',
        lifecycle: 'published',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    await blockingOccurrence(FINDING); // fix targets this CR's blocking findings
    const replies: string[] = [];
    const conv = transientConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      // Fix writes code on a branch: needs author or write permission.
      resolveActorPermission: async () => 'write',
      reply: async (_p, text) => {
        replies.push(text);
      },
    });
    await route({
      intent: { intent: 'fix-all', source: 'command' },
      conversation: conv,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        actorId: 'gh-1',
        body: '@winnowl fix all',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    const plan = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('conversation_id', '=', conv.id)
      .where('status', '=', 'proposed')
      .executeTakeFirst();
    const actions = plan!.actions as unknown as { type: string; findingIds?: string[] }[];
    expect(actions[0]!.type).toBe('create-stacked-pr');
    expect(actions[0]!.findingIds).toContain(FINDING);
    expect(replies[0]).toContain(plan!.id);
  });

  it('a command that arrived before its pull request was registered: retried until it is, then routed; out of retries, answered', async () => {
    const routed: ConversationRouteContext[] = [];
    const replies: string[] = [];
    const handler = createConversationTurnHandler({
      botName: 'winnowl',
      route: async (ctx) => void routed.push(ctx),
      reply: async (_p, text) => void replies.push(text),
    });
    const payload = (n: number) => ({
      tenantId: TENANT,
      target: { kind: 'change-request' as const, nativeId: `issue-${n}` },
      actorLogin: 'alice',
      body: '@winnowl review',
      repositoryId: REPO,
      pendingChange: { number: n, kind: 'pull-request' },
    });
    const run = (n: number, attemptCount: number) =>
      handler({ job: { payload: payload(n), attemptCount, maxAttempts: 6 } as never, db, sandbox: noopSandbox, signal: new AbortController().signal, log: () => undefined });

    // Not registered yet (#4242): a retryable failure, nothing routed or answered.
    await expect(run(4242, 1)).rejects.toMatchObject({ failureClass: 'retryable_provider', retryable: true });
    expect(routed).toHaveLength(0);
    // Registered (#42, the fixture): resolved and routed with its id.
    await run(42, 2);
    expect(routed.at(-1)?.payload.changeRequestId).toBe(CR);
    // Still unknown on the last attempt: a reply instead of silence.
    await run(4242, 6);
    expect(routed).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('review');
  });

  it('a pull request no webhook ever announced is registered from the forge once its opened event had time to arrive', async () => {
    const routed: ConversationRouteContext[] = [];
    let lookups = 0;
    const provider = {
      changes: {
        get: async (ref: { number: number; repositoryId: string; id: string }) => {
          lookups += 1;
          return {
            ref: { ...ref, nativeId: 'gh-pr-7777', kind: 'pull-request' },
            revision: { id: 'r', changeRequestId: ref.id, baseSha: 'base-7', headSha: 'head-7', mergeBaseSha: '', sourceBranch: 'old-feat', targetBranch: 'main', createdAt: '' },
            title: 'old pr',
            description: '',
            state: 'open',
            draft: false,
            author: { providerUserId: '77', login: 'carol', type: 'user' },
            labels: [],
            reviewers: [],
            linkedIssues: [],
            mergeability: 'unknown',
            trust: 'same-repo-trusted',
            capabilities: {},
          };
        },
      },
    } as unknown as SourceControlProvider;
    const handler = createConversationTurnHandler({
      botName: 'winnowl',
      route: async (ctx) => void routed.push(ctx),
      registerChangeRequest: createChangeRequestRegistrar({ db, buildProvider: async () => provider }),
    });
    const run = (attemptCount: number) =>
      handler({
        job: {
          payload: { tenantId: TENANT, target: { kind: 'change-request', nativeId: 'issue-7777' }, actorLogin: 'carol', body: '@winnowl review', repositoryId: REPO, pendingChange: { number: 7777, kind: 'pull-request' } },
          attemptCount,
          maxAttempts: 6,
        } as never,
        db,
        sandbox: noopSandbox,
        signal: new AbortController().signal,
        log: () => undefined,
      });

    // Early attempts still wait for the opened event, without asking the forge.
    await expect(run(1)).rejects.toMatchObject({ failureClass: 'retryable_provider' });
    expect(lookups).toBe(0);
    await run(3);
    const cr = await db.selectFrom('change_requests').selectAll().where('repository_id', '=', REPO).where('number', '=', 7777).executeTakeFirstOrThrow();
    expect(cr).toMatchObject({ native_id: 'gh-pr-7777', author: 'carol', author_provider_id: '77', source_branch: 'old-feat', state: 'open' });
    expect(routed.at(-1)?.payload.changeRequestId).toBe(cr.id);
    const revs = await db.selectFrom('revisions').select('head_sha').where('change_request_id', '=', cr.id).execute();
    expect(revs.map((r) => r.head_sha)).toEqual(['head-7']);
  });

  it('`approve` in the thread approves the newest pending plan the commenter asked for and queues it', async () => {
    const replies: string[] = [];
    const conv = transientConversation({
      tenantId: TENANT,
      target: { kind: 'change-request', nativeId: '42' },
      repositoryId: REPO,
      changeRequestId: CR,
    });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      resolveActorPermission: async () => 'write',
      reply: async (_p, text) => {
        replies.push(text);
      },
    });
    const say = (body: string, intent: Parameters<typeof route>[0]['intent'], actorId = 'gh-1') =>
      route({
        intent,
        conversation: conv,
        payload: { tenantId: TENANT, target: { kind: 'change-request', nativeId: '42' }, actorLogin: actorId, actorId, body, repositoryId: REPO, changeRequestId: CR },
        db,
      });
    await say('@winnowl generate tests', { intent: 'generate-tests', source: 'command' });
    const plan = await db.selectFrom('action_plans').select('id').where('conversation_id', '=', conv.id).executeTakeFirstOrThrow();
    expect(replies.at(-1)).toContain('@winnowl approve');

    const status = async () => (await db.selectFrom('action_plans').select('status').where('id', '=', plan.id).executeTakeFirstOrThrow()).status;
    // Someone else, and an id too short to tell plans apart: nothing is approved (each gets a reply).
    await say('@winnowl approve', { intent: 'approve-plan', source: 'command' }, 'gh-2');
    await say('@winnowl approve 01a', { intent: 'approve-plan', source: 'command', argument: '01a' });
    expect(await status()).toBe('proposed');
    expect(replies).toHaveLength(3);

    await say('@winnowl approve', { intent: 'approve-plan', source: 'command' });
    expect(replies.at(-1)).toContain(plan.id);
    expect(await status()).toBe('approved');
    // The approval channel is recorded so execution re-validates via the provider, not console membership.
    expect(
      (
        await db
          .selectFrom('action_plans')
          .select('approval_provenance')
          .where('id', '=', plan.id)
          .executeTakeFirstOrThrow()
      ).approval_provenance,
    ).toMatchObject({ source: 'provider-comment', actorId: 'gh-1', login: 'gh-1', host: 'x' });
    const job = await db.selectFrom('jobs').select('type').where('dedupe_key', '=', `action-execute:${plan.id}`).executeTakeFirst();
    expect(job?.type).toBe('action_execute');
    expect((await loadConversation(db, TENANT, conv.id))!.state).toBe('active');

    // Nothing pending any more: a reply, no second job.
    await say('@winnowl approve', { intent: 'approve-plan', source: 'command' });
    expect(replies).toHaveLength(5);
    expect(await db.selectFrom('jobs').select('id').where('dedupe_key', '=', `action-execute:${plan.id}`).execute()).toHaveLength(1);
  });

  it('generate-tests → 提议 create-stacked-pr(fixKind=generate-tests,§28.6)', async () => {
    const replies: string[] = [];
    const conv = transientConversation({
      tenantId: TENANT,
      target: { kind: 'change-request', nativeId: '42' },
      repositoryId: REPO,
      changeRequestId: CR,
    });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      // Fix writes code on a branch: needs author or write permission.
      resolveActorPermission: async () => 'write',
      reply: async (_p, t) => {
        replies.push(t);
      },
    });
    await route({
      intent: { intent: 'generate-tests', source: 'command' },
      conversation: conv,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        actorId: 'gh-1',
        body: '@winnowl generate tests',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    const plan = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('conversation_id', '=', conv.id)
      .where('status', '=', 'proposed')
      .executeTakeFirst();
    const actions = plan!.actions as unknown as { type: string; fixKind?: string }[];
    expect(actions[0]!.type).toBe('create-stacked-pr');
    expect(actions[0]!.fixKind).toBe('generate-tests'); // no findingIds: targets the change
    expect(replies[0]).toContain(plan!.id);
  });

  it('implement-issue(Issue 目标)→ 提议 create-cr-from-issue plan(带 issueNumber,§30.3)', async () => {
    const replies: string[] = [];
    const conv = transientConversation({
        tenantId: TENANT,
        target: { kind: 'issue', nativeId: '321' },
        repositoryId: REPO,
      });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      // No CR on an issue: gate on repository write permission, same as fix.
      resolveActorPermission: async () => 'write',
      reply: async (_p, t) => {
        replies.push(t);
      },
    });
    await route({
      intent: { intent: 'implement-issue', argument: 'add retry', source: 'command' },
      conversation: conv,
      payload: {
        tenantId: TENANT,
        target: { kind: 'issue', nativeId: '321' },
        actorLogin: 'alice',
        actorId: 'gh-1',
        body: '@winnowl implement add retry',
        repositoryId: REPO,
        issueNumber: 8,
      },
      db,
    });
    const plan = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('conversation_id', '=', conv.id)
      .where('status', '=', 'proposed')
      .executeTakeFirst();
    const actions = plan!.actions as unknown as { type: string; issueNumber?: number }[];
    expect(actions[0]!.type).toBe('create-cr-from-issue');
    expect(actions[0]!.issueNumber).toBe(8);
    expect(plan!.revision_sha).toBeNull(); // issues have no head
    expect(replies[0]).toContain(plan!.id);
  });

  it('actions.autofix.enabled=false → 不提议 plan,回执已禁用(§37)', async () => {
    const settings = {
      language: 'zh',
      actions: { autofix: { enabled: false } },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'x',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();
    const replies: string[] = [];
    const conv = transientConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      // Fix writes code on a branch: needs author or write permission.
      resolveActorPermission: async () => 'write',
      reply: async (_p, text) => {
        replies.push(text);
      },
    });
    await route({
      intent: { intent: 'fix-all', source: 'command' },
      conversation: conv,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        actorId: 'gh-1',
        body: '@winnowl fix all',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    const plan = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('conversation_id', '=', conv.id)
      .executeTakeFirst();
    expect(plan).toBeUndefined();
    expect(replies[0]).toContain('禁用');
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute(); // clean up the shared REPO
  });

  it('actions.autofix.require_confirmation=false → 直接落 approved 并入队 action_execute(§37)', async () => {
    const settings = {
      language: 'zh',
      actions: { autofix: { enabled: true, require_confirmation: false } },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'x',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();
    const FINDING = uuidv7();
    await db
      .insertInto('findings')
      .values({
        id: FINDING,
        tenant_id: TENANT,
        repository_id: REPO,
        semantic_fingerprint: `fp-${FINDING}`,
        category: 'correctness',
        canonical_claim: 'pre-authorized fix',
        lifecycle: 'published',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    await blockingOccurrence(FINDING);
    const replies: string[] = [];
    const conv = transientConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      // Fix writes code on a branch: needs author or write permission.
      resolveActorPermission: async () => 'write',
      reply: async (_p, text) => {
        replies.push(text);
      },
    });
    await route({
      intent: { intent: 'fix-all', source: 'command' },
      conversation: conv,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        actorId: 'gh-1',
        body: '@winnowl fix all',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    const plan = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('conversation_id', '=', conv.id)
      .executeTakeFirst();
    expect(plan?.status).toBe('approved'); // no confirmation needed: never proposed
    // Approval and enqueue share a transaction: an approved plan without a job would never run.
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('dedupe_key', '=', `action-execute:${plan!.id}`)
      .executeTakeFirst();
    expect(job?.type).toBe('action_execute');
    expect((await loadConversation(db, TENANT, conv.id))!.state).toBe('active');
    expect(replies[0]).toContain('免确认');
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  it('actions.autofix.delivery 不含 stacked-change-request → 不提议 plan,回执配置原因(§37)', async () => {
    const settings = {
      language: 'zh',
      actions: { autofix: { enabled: true, delivery: ['artifact'] } },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'x',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();
    const replies: string[] = [];
    const conv = transientConversation({
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        repositoryId: REPO,
        changeRequestId: CR,
      });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      // Fix writes code on a branch: needs author or write permission.
      resolveActorPermission: async () => 'write',
      reply: async (_p, text) => {
        replies.push(text);
      },
    });
    await route({
      intent: { intent: 'generate-tests', source: 'command' },
      conversation: conv,
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        actorId: 'gh-1',
        body: '@winnowl generate tests',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });
    expect(
      await db
        .selectFrom('action_plans')
        .selectAll()
        .where('conversation_id', '=', conv.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(replies[0]).toContain('stacked PR 交付已被仓库配置禁用');
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  it('chat.enabled=false → 记消息但完全不路由(§37)', async () => {
    const settings = {
      chat: { enabled: false, require_mention: true, allow_run_command: true },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'c',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();
    routed.length = 0;
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        body: '@winnowl review',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      dedupeKey: 'chat-disabled',
    });
    await supervisor().runOnce();
    expect(routed).toHaveLength(0); // chat disabled: even commands are not routed
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  it('bot 作者的写命令 → 不路由;只读意图照常放行(§26.3 机器人代命令守卫)', async () => {
    // Drain jobs queued by earlier tests.
    while (
      await new Supervisor({
        db,
        sandbox: noopSandbox,
        workerId,
        handlers: { conversation_turn: async () => undefined },
      }).runOnce()
    ) {
      /* drain */
    }
    routed.length = 0;
    // A third-party bot (our own comments are never enqueued) asking for a write is blocked.
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'coderabbitai[bot]',
        actorIsBot: true,
        body: '@winnowl fix all',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      dedupeKey: 'bot-write',
    });
    while (await supervisor().runOnce()) {
      /* drain */
    }
    expect(routed).toHaveLength(0);
    // A read-only review from the same bot is allowed (CI bots trigger reviews).
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'conversation_turn',
      payload: {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'coderabbitai[bot]',
        actorIsBot: true,
        body: '@winnowl review',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      dedupeKey: 'bot-read',
    });
    while (await supervisor().runOnce()) {
      /* drain */
    }
    expect(routed.map((r) => r.intent.intent)).toEqual(['review']);
  });

  /** Reply language follows repo config; earlier tests clear repository_settings, so set zh here. */
  async function withZhConfig(
    settings: Record<string, unknown>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const merged = { language: 'zh', ...settings } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings: merged,
        config_digest: 'zh',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings: merged }))
      .execute();
    try {
      await fn();
    } finally {
      await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
    }
  }

  it('a read-only command the agent runs is routed like a typed one', async () => {
    const route = createConversationRoute();
    await route({
      intent: { intent: 'explain-finding', source: 'agent' },
      conversation: {} as never,
      payload: {
        tenantId: TENANT,
        target: { kind: 'review-thread', nativeId: 't-nl' },
        actorLogin: 'alice',
        body: '这个发现是什么意思?',
        repositoryId: REPO,
        changeRequestId: CR,
        anchorPath: 'src/nl.ts',
      },
      db,
    });
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'explain_finding')
      .where('dedupe_key', '=', `explain:${CR}:src/nl.ts`)
      .executeTakeFirst();
    expect(job).toBeTruthy();
  });

  it('ignore → 落 finding_dismissals(本 CR)+ feedback + 翻门禁;unignore 撤销(§26.4)', async () => {
    const FINDING = uuidv7();
    const PUB = uuidv7();
    await db
      .insertInto('findings')
      .values({
        id: FINDING,
        tenant_id: TENANT,
        repository_id: REPO,
        semantic_fingerprint: `fp-${FINDING}`,
        category: 'correctness',
        canonical_claim: 'noisy nit',
        lifecycle: 'published',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    await db
      .insertInto('publication_records')
      .values({
        id: PUB,
        tenant_id: TENANT,
        repository_id: REPO,
        change_request_id: CR,
        revision_id: REV,
        finding_id: FINDING,
        provider_host_id: HOST,
        kind: 'inline',
        idempotency_key: 'k-c-ignore',
        provider_native_id: 'c-ignore',
        provider_url: null,
        state: 'published',
        request_digest: 'd',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    // A blocking occurrence on this CR: ignoring it drops it from the gate.
    await blockingOccurrence(FINDING);
    expect((await loadChangeRequestBlockingFindings(db, CR)).some((f) => f.id === FINDING)).toBe(
      true,
    );

    const replies: string[] = [];
    const gateCalls: { changeRequestId: string }[] = [];
    const conv = transientConversation({
        tenantId: TENANT,
        target: { kind: 'review-thread', nativeId: 'c-ignore' },
        repositoryId: REPO,
        changeRequestId: CR,
      });
    await insertConversation(db, conv);
    const route = createConversationRoute({
      reply: async (_p, t) => {
        replies.push(t);
      },
      recomputeGate: async (i) => {
        gateCalls.push(i);
      },
    });
    const payload = {
      tenantId: TENANT,
      target: { kind: 'review-thread' as const, nativeId: 'c-ignore' },
      actorLogin: 'alice',
      actorId: 'gh-author',
      body: '@winnowl ignore',
      repositoryId: REPO,
      changeRequestId: CR,
    };
    await route({
      intent: { intent: 'ignore-finding', source: 'command' },
      conversation: conv,
      payload,
      db,
    });

    // PR-level: writes a relation row and leaves the repository-wide finding.lifecycle untouched.
    const dismissal = await db
      .selectFrom('finding_dismissals')
      .selectAll()
      .where('finding_id', '=', FINDING)
      .executeTakeFirstOrThrow();
    expect(dismissal.change_request_id).toBe(CR);
    expect(dismissal.actor).toBe('gh-author');
    expect(
      (
        await db
          .selectFrom('findings')
          .selectAll()
          .where('id', '=', FINDING)
          .executeTakeFirstOrThrow()
      ).lifecycle,
    ).toBe('published');
    // Gate: this CR's blocking set excludes it.
    expect((await loadChangeRequestBlockingFindings(db, CR)).some((f) => f.id === FINDING)).toBe(
      false,
    );
    // Later reviews: the fingerprint is in the ignored set and suppressed before publishing.
    expect((await loadDismissedFindings(db, CR)).map((d) => d.fingerprint)).toContain(
      `fp-${FINDING}`,
    );
    const fb = await db
      .selectFrom('feedbacks')
      .selectAll()
      .where('finding_id', '=', FINDING)
      .executeTakeFirst();
    expect(fb?.class).toBe('not-important');
    expect(gateCalls).toEqual([{ tenantId: TENANT, repositoryId: REPO, changeRequestId: CR }]);
    expect(replies[0]).toContain('noisy nit');

    // unignore deletes the row, counts the finding in the gate again and flips the gate.
    await route({
      intent: { intent: 'unignore-finding', source: 'command' },
      conversation: conv,
      payload,
      db,
    });
    expect(
      await db
        .selectFrom('finding_dismissals')
        .selectAll()
        .where('finding_id', '=', FINDING)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect((await loadChangeRequestBlockingFindings(db, CR)).some((f) => f.id === FINDING)).toBe(
      true,
    );
    expect(gateCalls).toHaveLength(2);
    // Unignoring again only replies; no gate flip.
    await route({
      intent: { intent: 'unignore-finding', source: 'command' },
      conversation: conv,
      payload,
      db,
    });
    expect(gateCalls).toHaveLength(2);
    expect(replies.at(-1)).toContain('not ignored'); // no zh config in this test: English reply
  });

  it('顶层 ignore = 忽略整个 PR(停自动 review),不是忽略某条 finding(§26.4)', async () => {
    const replies: string[] = [];
    const route = createConversationRoute({
      reply: async (_p, t) => {
        replies.push(t);
      },
    });
    const topLevel = {
      tenantId: TENANT,
      target: { kind: 'change-request' as const, nativeId: '42' },
      actorLogin: 'alice',
      actorId: 'gh-author',
      body: '@winnowl ignore',
      repositoryId: REPO,
      changeRequestId: CR,
    };
    await withZhConfig({}, async () => {
      // Top level has no finding context: it means "skip this PR", the same switch as pause.
      await route({
        intent: { intent: 'ignore-finding', source: 'command' },
        conversation: {} as never,
        payload: topLevel,
        db,
      });
      expect(
        (
          await db
            .selectFrom('change_requests')
            .selectAll()
            .where('id', '=', CR)
            .executeTakeFirstOrThrow()
        ).auto_review_paused,
      ).toBe(true);
      expect(
        await db
          .selectFrom('finding_dismissals')
          .selectAll()
          .where('change_request_id', '=', CR)
          .execute(),
      ).toHaveLength(0); // findings untouched
      expect(replies[0]).toContain('已忽略本 PR');
      // Top-level unignore resumes.
      await route({
        intent: { intent: 'unignore-finding', source: 'command' },
        conversation: {} as never,
        payload: topLevel,
        db,
      });
      expect(
        (
          await db
            .selectFrom('change_requests')
            .selectAll()
            .where('id', '=', CR)
            .executeTakeFirstOrThrow()
        ).auto_review_paused,
      ).toBe(false);
      // An explicit `ignore pr` command does the same, even inline.
      await route({
        intent: { intent: 'ignore-pr', source: 'command' },
        conversation: {} as never,
        payload: { ...topLevel, target: { kind: 'review-thread', nativeId: 'c-ignore' } },
        db,
      });
      expect(
        (
          await db
            .selectFrom('change_requests')
            .selectAll()
            .where('id', '=', CR)
            .executeTakeFirstOrThrow()
        ).auto_review_paused,
      ).toBe(true);
      await db
        .updateTable('change_requests')
        .set({ auto_review_paused: false })
        .where('id', '=', CR)
        .execute();
    });
  });

  // ignore must also cancel the in-flight review, not only pause the next trigger.
  it('顶层 ignore / pause 同时停掉在途 review(不只是挡下一次触发)', async () => {
    // A fresh dedupe key each time: one active review per CR, so a reused key returns the old job.
    const inflight = async (): Promise<string> => {
      const headSha = uuidv7();
      const { jobId } = await enqueueJob(db, {
        tenantId: TENANT,
        type: 'review_revision',
        payload: {
          tenantId: TENANT,
          repositoryId: REPO,
          changeRequestId: CR,
          revisionId: REV,
          headSha,
          configDigest: '',
        },
        dedupeKey: `review:${REPO}:${CR}:${headSha}:`,
      });
      await db.updateTable('jobs').set({ status: 'running' }).where('id', '=', jobId).execute();
      return jobId;
    };
    const cancelRequested = async (jobId: string): Promise<boolean> =>
      (
        await db
          .selectFrom('jobs')
          .select('cancellation_requested')
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow()
      ).cancellation_requested;

    const replies: string[] = [];
    const route = createConversationRoute({
      reply: async (_p, t) => {
        replies.push(t);
      },
    });
    const topLevel = {
      tenantId: TENANT,
      target: { kind: 'change-request' as const, nativeId: '42' },
      actorLogin: 'alice',
      actorId: 'gh-author',
      body: '@winnowl ignore',
      repositoryId: REPO,
      changeRequestId: CR,
    };

    await withZhConfig({}, async () => {
      const ignored = await inflight();
      await route({
        intent: { intent: 'ignore-finding', source: 'command' },
        conversation: {} as never,
        payload: topLevel,
        db,
      });
      expect(await cancelRequested(ignored)).toBe(true);
      // The reply mentions the cancellation, or it reads as if the current run continues.
      expect(replies.at(-1)).toContain('正在跑的那一轮已经停下');

      const paused = await inflight();
      await route({
        intent: { intent: 'pause-reviews', source: 'command' },
        conversation: {} as never,
        payload: topLevel,
        db,
      });
      expect(await cancelRequested(paused)).toBe(true);

      // resume only flips the switch; it never starts a review.
      const survivor = await inflight();
      await route({
        intent: { intent: 'resume-reviews', source: 'command' },
        conversation: {} as never,
        payload: topLevel,
        db,
      });
      expect(
        (
          await db
            .selectFrom('change_requests')
            .selectAll()
            .where('id', '=', CR)
            .executeTakeFirstOrThrow()
        ).auto_review_paused,
      ).toBe(false);
      expect(await cancelRequested(survivor)).toBe(false);
      await db
        .deleteFrom('jobs')
        .where('type', '=', 'review_revision')
        .where('payload', '@>', JSON.stringify({ changeRequestId: CR }))
        .execute();
    });
  });

  it('ignore 是 PR 级:同一 finding 在另一个 CR 上不受影响(§26.4)', async () => {
    const FINDING = uuidv7();
    const CR2 = uuidv7();
    const REV2 = uuidv7();
    await db
      .insertInto('findings')
      .values({
        id: FINDING,
        tenant_id: TENANT,
        repository_id: REPO,
        semantic_fingerprint: `fp-${FINDING}`,
        category: 'correctness',
        canonical_claim: 'shared issue',
        lifecycle: 'published',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    await db
      .insertInto('change_requests')
      .values({
        id: CR2,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '77',
        number: 77,
        kind: 'pull-request',
        source_branch: 'feat2',
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
        id: REV2,
        tenant_id: TENANT,
        change_request_id: CR2,
        base_sha: 'b',
        head_sha: 'head-77',
        merge_base_sha: null,
        source_branch: 'feat2',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    // The same finding has a blocking occurrence on two CRs.
    for (const rev of [REV, REV2]) await blockingOccurrence(FINDING, rev);
    await dismissFindingForChangeRequest(db, {
      tenantId: TENANT,
      findingId: FINDING,
      changeRequestId: CR,
    });
    expect((await loadChangeRequestBlockingFindings(db, CR)).some((f) => f.id === FINDING)).toBe(
      false,
    );
    expect((await loadChangeRequestBlockingFindings(db, CR2)).some((f) => f.id === FINDING)).toBe(
      true,
    ); // the other PR still blocks
    expect(await loadDismissedFindings(db, CR2)).toHaveLength(0);
  });

  it('反馈目标同时绑定当前 CR,相同 provider comment id 不会命中另一个 CR', async () => {
    const CR2 = uuidv7();
    const REV2 = uuidv7();
    const CURRENT_FINDING = uuidv7();
    const OTHER_FINDING = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: CR2,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: 'collision-cr',
        number: 78,
        kind: 'pull-request',
        source_branch: 'collision',
        target_branch: 'main',
        state: 'open',
        draft: false,
        author: 'alice',
        author_provider_id: 'gh-author',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values({
        id: REV2,
        tenant_id: TENANT,
        change_request_id: CR2,
        base_sha: 'base-collision',
        head_sha: 'head-collision',
        merge_base_sha: null,
        source_branch: 'collision',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('findings')
      .values(
        [CURRENT_FINDING, OTHER_FINDING].map((id, index) => ({
          id,
          tenant_id: TENANT,
          repository_id: REPO,
          semantic_fingerprint: `collision-fp-${index}`,
          category: 'correctness',
          canonical_claim: index === 0 ? 'current CR finding' : 'other CR finding',
          lifecycle: 'published' as const,
          first_seen_at: new Date(),
          last_seen_at: new Date(),
        })),
      )
      .execute();
    await db
      .insertInto('publication_records')
      .values([
        {
          id: uuidv7(),
          tenant_id: TENANT,
          repository_id: REPO,
          change_request_id: CR2,
          revision_id: REV2,
          finding_id: OTHER_FINDING,
          provider_host_id: HOST,
          kind: 'inline',
          idempotency_key: 'collision-other',
          provider_native_id: 'shared-comment-id',
          provider_url: null,
          state: 'published',
          request_digest: 'd-other',
          created_at: new Date(Date.now() + 1_000),
          updated_at: new Date(),
        },
        {
          id: uuidv7(),
          tenant_id: TENANT,
          repository_id: REPO,
          change_request_id: CR,
          revision_id: REV,
          finding_id: CURRENT_FINDING,
          provider_host_id: HOST,
          kind: 'inline',
          idempotency_key: 'collision-current',
          provider_native_id: 'shared-comment-id',
          provider_url: null,
          state: 'published',
          request_digest: 'd-current',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ])
      .execute();

    await createConversationRoute()({
      intent: { intent: 'ignore-finding', source: 'command' },
      conversation: {} as never,
      payload: {
        tenantId: TENANT,
        target: { kind: 'review-thread', nativeId: 'shared-comment-id' },
        actorLogin: 'alice',
        actorId: 'gh-author',
        body: '@winnowl ignore',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      db,
    });

    const dismissals = await db
      .selectFrom('finding_dismissals')
      .select(['finding_id', 'change_request_id'])
      .where('finding_id', 'in', [CURRENT_FINDING, OTHER_FINDING])
      .execute();
    expect(dismissals).toEqual([{ finding_id: CURRENT_FINDING, change_request_id: CR }]);
  });

  it('ignore:非作者 → 拒绝;回复的不是 finding 评论 → 引导(不猜、也不波及整个 PR)', async () => {
    const FINDING = uuidv7();
    const PUB = uuidv7();
    await db
      .insertInto('findings')
      .values({
        id: FINDING,
        tenant_id: TENANT,
        repository_id: REPO,
        semantic_fingerprint: `fp-${FINDING}`,
        category: 'correctness',
        canonical_claim: 'still active',
        lifecycle: 'published',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    await db
      .insertInto('publication_records')
      .values({
        id: PUB,
        tenant_id: TENANT,
        repository_id: REPO,
        change_request_id: CR,
        revision_id: REV,
        finding_id: FINDING,
        provider_host_id: HOST,
        kind: 'inline',
        idempotency_key: 'k-c-other',
        provider_native_id: 'c-other',
        provider_url: null,
        state: 'published',
        request_digest: 'd',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const replies: string[] = [];
    // Only the maintainer has write permission; everyone else has none.
    const permissions: Record<string, RepositoryPermission> = {
      'gh-maintainer': 'maintain',
      'gh-triager': 'triage',
      'gh-stranger': 'none',
    };
    const route = createConversationRoute({
      reply: async (_p, t) => {
        replies.push(t);
      },
      resolveActorPermission: async (_repo, actor) =>
        permissions[actor.providerUserId ?? ''] ?? 'none',
    });
    await withZhConfig({}, async () => {
      // A stranger (not the author, no permission) cannot ignore a finding on someone else's PR.
      await route({
        intent: { intent: 'ignore-finding', source: 'command' },
        conversation: {} as never,
        payload: {
          tenantId: TENANT,
          target: { kind: 'review-thread', nativeId: 'c-other' },
          actorLogin: 'stranger',
          actorId: 'gh-stranger',
          body: '@winnowl ignore',
          repositoryId: REPO,
          changeRequestId: CR,
        },
        db,
      });
      expect(
        (
          await db
            .selectFrom('findings')
            .selectAll()
            .where('id', '=', FINDING)
            .executeTakeFirstOrThrow()
        ).lifecycle,
      ).toBe('published');
      expect(replies[0]).toContain('作者');
      // triage permission is not enough to lift the gate.
      await route({
        intent: { intent: 'ignore-finding', source: 'command' },
        conversation: {} as never,
        payload: {
          tenantId: TENANT,
          target: { kind: 'review-thread', nativeId: 'c-other' },
          actorLogin: 'triager',
          actorId: 'gh-triager',
          body: '@winnowl ignore',
          repositoryId: REPO,
          changeRequestId: CR,
        },
        db,
      });
      expect(
        (
          await db
            .selectFrom('findings')
            .selectAll()
            .where('id', '=', FINDING)
            .executeTakeFirstOrThrow()
        ).lifecycle,
      ).toBe('published');
      // Inline reply to a non-finding comment: a guidance reply, and the PR is not muted.
      await route({
        intent: { intent: 'ignore-finding', source: 'command' },
        conversation: {} as never,
        payload: {
          tenantId: TENANT,
          target: { kind: 'review-thread', nativeId: 'c-not-a-finding' },
          actorLogin: 'alice',
          actorId: 'gh-author',
          body: '@winnowl ignore',
          repositoryId: REPO,
          changeRequestId: CR,
        },
        db,
      });
      expect(
        (
          await db
            .selectFrom('change_requests')
            .selectAll()
            .where('id', '=', CR)
            .executeTakeFirstOrThrow()
        ).auto_review_paused,
      ).toBe(false);
      expect(replies[2]).toContain('行内评论'); // 0 = stranger denied, 1 = triage denied, 2 = no target
      // A maintainer with write permission (not the author) is allowed.
      await route({
        intent: { intent: 'ignore-finding', source: 'command' },
        conversation: {} as never,
        payload: {
          tenantId: TENANT,
          target: { kind: 'review-thread', nativeId: 'c-other' },
          actorLogin: 'maintainer',
          actorId: 'gh-maintainer',
          body: '@winnowl ignore',
          repositoryId: REPO,
          changeRequestId: CR,
        },
        db,
      });
      expect(
        await db
          .selectFrom('finding_dismissals')
          .selectAll()
          .where('finding_id', '=', FINDING)
          .executeTakeFirst(),
      ).toBeTruthy();
    });
  });

  it('ignore:权限查询抛错(凭据/网络问题)→ 不放行', async () => {
    const FINDING = uuidv7();
    const PUB = uuidv7();
    await db
      .insertInto('findings')
      .values({
        id: FINDING,
        tenant_id: TENANT,
        repository_id: REPO,
        semantic_fingerprint: `fp-${FINDING}`,
        category: 'correctness',
        canonical_claim: 'perm error',
        lifecycle: 'published',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    await db
      .insertInto('publication_records')
      .values({
        id: PUB,
        tenant_id: TENANT,
        repository_id: REPO,
        change_request_id: CR,
        revision_id: REV,
        finding_id: FINDING,
        provider_host_id: HOST,
        kind: 'inline',
        idempotency_key: 'k-c-err',
        provider_native_id: 'c-err',
        provider_url: null,
        state: 'published',
        request_digest: 'd',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const route = createConversationRoute({
      // The production adapter catches and returns 'none'; throwing here checks the route fails instead of allowing.
      resolveActorPermission: async () => {
        throw new Error('403 Resource not accessible by integration');
      },
    });
    await expect(
      route({
        intent: { intent: 'ignore-finding', source: 'command' },
        conversation: {} as never,
        payload: {
          tenantId: TENANT,
          target: { kind: 'review-thread', nativeId: 'c-err' },
          actorLogin: 'stranger',
          actorId: 'gh-stranger',
          body: '@winnowl ignore',
          repositoryId: REPO,
          changeRequestId: CR,
        },
        db,
      }),
    ).rejects.toThrow('403'); // a retryable failure beats silently allowing
    expect(
      (
        await db
          .selectFrom('findings')
          .selectAll()
          .where('id', '=', FINDING)
          .executeTakeFirstOrThrow()
      ).lifecycle,
    ).toBe('published');
  });

  it('pause / resume → 翻 change_requests.auto_review_paused(作者或写权限)', async () => {
    const replies: string[] = [];
    const route = createConversationRoute({
      reply: async (_p, t) => {
        replies.push(t);
      },
      resolveActorPermission: async (_repo, actor) =>
        actor.providerUserId === 'gh-maintainer' ? 'maintain' : 'none',
    });
    const payloadOf = (actorId: string) => ({
      tenantId: TENANT,
      target: { kind: 'change-request' as const, nativeId: '42' },
      actorLogin: 'x',
      actorId,
      body: '@winnowl pause',
      repositoryId: REPO,
      changeRequestId: CR,
    });
    await withZhConfig({}, async () => {
      // Not the author and no permission: denied, or anyone could turn off reviews on others' PRs.
      await route({
        intent: { intent: 'pause-reviews', source: 'command' },
        conversation: {} as never,
        payload: payloadOf('gh-stranger'),
        db,
      });
      expect(
        (
          await db
            .selectFrom('change_requests')
            .selectAll()
            .where('id', '=', CR)
            .executeTakeFirstOrThrow()
        ).auto_review_paused,
      ).toBe(false);
      expect(replies[0]).toContain('作者');
      // The author is allowed.
      await route({
        intent: { intent: 'pause-reviews', source: 'command' },
        conversation: {} as never,
        payload: payloadOf('gh-author'),
        db,
      });
      expect(
        (
          await db
            .selectFrom('change_requests')
            .selectAll()
            .where('id', '=', CR)
            .executeTakeFirstOrThrow()
        ).auto_review_paused,
      ).toBe(true);
      // A maintainer (not the author) can resume too.
      await route({
        intent: { intent: 'resume-reviews', source: 'command' },
        conversation: {} as never,
        payload: payloadOf('gh-maintainer'),
        db,
      });
      expect(
        (
          await db
            .selectFrom('change_requests')
            .selectAll()
            .where('id', '=', CR)
            .executeTakeFirstOrThrow()
        ).auto_review_paused,
      ).toBe(false);
      // The author pauses again to check the reset path.
      await route({
        intent: { intent: 'pause-reviews', source: 'command' },
        conversation: {} as never,
        payload: payloadOf('gh-author'),
        db,
      });
      await route({
        intent: { intent: 'resume-reviews', source: 'command' },
        conversation: {} as never,
        payload: payloadOf('gh-author'),
        db,
      });
      expect(
        (
          await db
            .selectFrom('change_requests')
            .selectAll()
            .where('id', '=', CR)
            .executeTakeFirstOrThrow()
        ).auto_review_paused,
      ).toBe(false);
    });
  });

  it('issue 上 @winnowl plan → 入队 issue_enrich(mode plan)', async () => {
    const route = createConversationRoute();
    await route({
      intent: { intent: 'plan-issue', source: 'command' },
      conversation: {} as never,
      payload: {
        tenantId: TENANT,
        target: { kind: 'issue', nativeId: '6001' },
        actorLogin: 'alice',
        body: '@winnowl plan',
        repositoryId: REPO,
        issueNumber: 15,
      },
      db,
    });
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'issue_enrich')
      .where('dedupe_key', '=', `issue-plan:${REPO}:15`)
      .executeTakeFirst();
    expect(job).toBeTruthy();
    expect((job!.payload as { mode?: string }).mode).toBe('plan');
    expect((job!.payload as { issueNativeId?: string }).issueNativeId).toBe('6001');
  });

  it('a mention that is no command goes to the conversation agent; plain comments and bots do not', async () => {
    // Drain jobs queued by earlier tests.
    while (await new Supervisor({ db, sandbox: noopSandbox, workerId, handlers: { conversation_turn: async () => undefined } }).runOnce()) {
      /* drain */
    }
    const started: { body: string; conversationId: string }[] = [];
    const localRouted: ConversationRouteContext[] = [];
    const handler = createConversationTurnHandler({
      botName: 'winnowl',
      route: async (ctx) => void localRouted.push(ctx),
      startAgent: async ({ payload, conversation }) => void started.push({ body: payload.body, conversationId: conversation.id }),
    });
    const run = async (body: string, extra: Record<string, unknown> = {}) => {
      await enqueueJob(db, {
        tenantId: TENANT,
        type: 'conversation_turn',
        payload: { tenantId: TENANT, target: { kind: 'change-request', nativeId: '42' }, actorLogin: 'alice', body, ...extra },
        dedupeKey: uuidv7(),
      });
      await new Supervisor({ db, sandbox: noopSandbox, workerId, handlers: { conversation_turn: handler } }).runOnce();
    };
    await run('@winnowl 这个发现是什么意思?');
    await run('just a normal comment');
    await run('@winnowl why?', { actorIsBot: true, actorLogin: 'other[bot]' });
    await run('@winnowl review');
    expect(started.map((s) => s.body)).toEqual(['@winnowl 这个发现是什么意思?']);
    expect(localRouted.map((r) => r.intent.intent)).toEqual(['review']);
  });

  it('createConversationReply → Provider.createTopLevelComment(带 CR ref)', async () => {
    const posted: {
      target: { kind: string; ref: { number: number } };
      body: { markdown: string };
    }[] = [];
    const stub = {
      discussions: {
        createTopLevelComment: async (target: unknown, body: unknown) => {
          posted.push({ target, body } as never);
          return { nativeId: 'c1' };
        },
      },
    } as unknown as SourceControlProvider;
    const reply = createConversationReply({ db, buildProvider: async () => stub });
    await reply(
      {
        tenantId: TENANT,
        target: { kind: 'change-request', nativeId: '42' },
        actorLogin: 'alice',
        body: 'x',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      'hello world',
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.markdown).toBe('hello world');
    expect(posted[0]!.target.ref.number).toBe(42);
  });

  it('createConversationReply:行内命令回**线程内**,不是顶层(此前 review-thread 被静默丢弃)', async () => {
    const replies: {
      thread: { nativeId: string; changeRequest?: { number: number } };
      body: { markdown: string };
    }[] = [];
    const topLevel: unknown[] = [];
    const stub = {
      discussions: {
        reply: async (thread: unknown, body: unknown) => {
          replies.push({ thread, body } as never);
          return { nativeId: 'r1' };
        },
        createTopLevelComment: async (t: unknown) => {
          topLevel.push(t);
          return { nativeId: 'c1' };
        },
      },
    } as unknown as SourceControlProvider;
    const reply = createConversationReply({ db, buildProvider: async () => stub });
    await reply(
      {
        tenantId: TENANT,
        target: { kind: 'review-thread', nativeId: 'thread-77' },
        actorLogin: 'alice',
        body: '@winnowl ignore',
        repositoryId: REPO,
        changeRequestId: CR,
      },
      '已忽略该 Finding',
    );
    expect(topLevel).toHaveLength(0); // nothing at top level
    expect(replies).toHaveLength(1);
    expect(replies[0]!.thread.nativeId).toBe('thread-77');
    expect(replies[0]!.thread.changeRequest?.number).toBe(42); // the thread ref needs CR context
    expect(replies[0]!.body.markdown).toBe('已忽略该 Finding');
  });
});
