import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRoutingFauxAgent } from '@reviewbot/agent-pi';
import { WorkspaceSourceProvider } from '@reviewbot/code-intel';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import type {
  ChangeRequestRef as CR,
  CommentReceipt,
  DiscussionThread,
  IdempotencyContext,
  ProviderAnchor,
  RichComment,
} from '@reviewbot/provider-contracts';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { currentLlmTraceContext, type LlmTraceContext } from '@reviewbot/telemetry';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createReviewRevisionHandler, type ReviewEnv } from '../src/review-revision.js';
import { Supervisor } from '../src/supervisor.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR_ID = uuidv7();
const REVISION_ID = uuidv7();
const HEAD = 'head-sha-1';

class StubDiscussions {
  comments: { nativeId: string; body: string }[] = [];
  threads: DiscussionThread[] = [];
  createInlineComment = async (
    _ref: CR,
    _anchor: ProviderAnchor,
    body: RichComment,
    _idem: IdempotencyContext,
  ): Promise<CommentReceipt> => {
    const nativeId = `c${this.comments.length + 1}`;
    this.comments.push({ nativeId, body: body.markdown });
    return { nativeId, url: 'u' };
  };
  topLevel: { nativeId: string; body: string }[] = [];
  createTopLevelComment = async (
    _target: unknown,
    body: RichComment,
    _idem: IdempotencyContext,
  ): Promise<CommentReceipt> => {
    const nativeId = `t${this.topLevel.length + 1}`;
    this.topLevel.push({ nativeId, body: body.markdown });
    return { nativeId, url: 'u' };
  };
  listThreads = async (): Promise<DiscussionThread[]> => this.threads;
}

/** The review handler uses no sandbox; a noop backend satisfies the Supervisor constructor. */
const noopSandbox: SandboxBackend = {
  create: async () => ({ id: 's', containerId: 'c' }),
  exec: async () => {
    throw new Error('sandbox not used by review handler');
  },
  putFile: async () => undefined,
  getArtifact: async () => ({ path: '', content: '', bytes: 0 }),
  destroy: async () => undefined,
};

describe('review_revision handler 端到端', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let dir: string;
  let source: WorkspaceSourceProvider;
  let bundles: ReviewEnv['bundles'];
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
        base_url: 'https://github.com',
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
        native_id: '999',
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
        id: CR_ID,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '42',
        number: 42,
        kind: 'pull-request',
        source_branch: 'feature/x',
        target_branch: 'main',
        state: 'open',
        draft: false,
        // Author gates (ignore_authors / bot authors) use it; an unknown author fails closed.
        author: 'octocat',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values({
        id: REVISION_ID,
        tenant_id: TENANT,
        change_request_id: CR_ID,
        base_sha: 'base-1',
        head_sha: HEAD,
        merge_base_sha: null,
        source_branch: 'feature/x',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();

    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });

    dir = await mkdtemp(join(tmpdir(), 'rvb-review-handler-'));
    await writeFile(join(dir, 'app.py'), 'def add(a, b):\n    return a + b\n');
    source = new WorkspaceSourceProvider(dir, [{ path: 'app.py', status: 'modified' }]);

    const loaded = await loadPromptBundles([
      'mapper',
      'reviewer',
      'synthesizer',
      'verifier',
      'refuter',
    ]);
    bundles = {
      mapper: loaded.mapper as PromptBundle,
      reviewer: loaded.reviewer as PromptBundle,
      synthesizer: loaded.synthesizer as PromptBundle,
      verifier: loaded.verifier as PromptBundle,
      refuter: loaded.refuter as PromptBundle,
    };
  });

  afterAll(async () => {
    await stop?.();
    await rm(dir, { recursive: true, force: true });
  });

  it('Job 消费 → 探索/verify/发布,产出 inline 评论与 publication_record', async () => {
    // Explicit enabled=true: tests share REPO and earlier ones store enabled=false.
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings: { reviews: { auto: { enabled: true } } },
        config_digest: 'on',
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('repository_id')
          .doUpdateSet({ settings: { reviews: { auto: { enabled: true } } } }),
      )
      .execute();
    const discussions = new StubDiscussions();
    // Routing faux: each stage has its own response queue keyed by finalization tool, so concurrent
    // pipelined invocations do not race (a sequential setResponses queue would).
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [
        faux.assistant(
          faux.toolCall('submit_plan', {
            scopes: [
              {
                title: 'add()',
                changeSummary: 'add',
                obligations: [{ kind: 'correctness', description: 'sum correct' }],
              },
            ],
          }),
        ),
      ],
      complete_section: [
        faux.assistant(
          faux.toolCall('submit_finding', {
            claim: 'off-by-one in add',
            category: 'correctness',
            suspectedSeverity: 'high',
            path: 'app.py',
            primaryAnchorText: 'return a + b',
            changeRelationHypothesis: 'introduced',
          }),
        ),
        faux.assistant(
          faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }),
        ),
      ],
      submit_summary: [
        faux.assistant(faux.toolCall('submit_summary', { note: 'no cross-scope issues' })),
      ],
      submit_assessment: [
        faux.assistant(
          faux.toolCall('submit_assessment', {
            decision: 'accept',
            introducedByChange: true,
            reachable: true,
            actionable: true,
            changeRelation: 'introduced',
            severity: 'high',
            confirmation: 'independently-verified',
            residualUncertainty: [],
          }),
        ),
      ],
      confirm_assessment: [
        faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] })),
      ],
    });

    // buildEnv assembles the sandbox executor spec from the current trace context, so
    // withLlmTraceContext must wrap buildEnv too, or erasure cannot locate sandbox traces.
    let traceAtBuildEnv: LlmTraceContext | undefined;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        traceAtBuildEnv = currentLlmTraceContext();
        return {
          source,
          model: faux.model,
          streamFn: faux.streamFn,
          bundles,
          budget: { maxTurns: 8, maxToolCalls: 16 },
          changeSummary: 'change add()',
          readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
          isChangedLine: () => true,
          publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
          noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
        };
      },
    });

    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });

    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: HEAD,
        configDigest: '',
      },
      dedupeKey: 'review-e2e-1',
    });

    expect(await supervisor.runOnce()).toBe(true);

    const status = await db
      .selectFrom('jobs')
      .select('status')
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe('completed');

    // Publishing side effects: inline comments (hidden marker) + publication_record.
    expect(discussions.comments).toHaveLength(1);
    expect(discussions.comments[0]!.body).toContain('winnowl:finding=');
    const rec = await db
      .selectFrom('publication_records')
      .selectAll()
      .where('change_request_id', '=', CR_ID)
      .where('kind', '=', 'inline')
      .executeTakeFirst();
    expect(rec?.state).toBe('published');

    // Top-level summary comment with a hidden marker + publication_record (kind=summary).
    expect(discussions.topLevel).toHaveLength(1);
    // The summary starts with "Actionable comments posted: N" and folds "Review details".
    expect(discussions.topLevel[0]!.body).toContain('Actionable comments posted');
    const summaryRec = await db
      .selectFrom('publication_records')
      .selectAll()
      .where('change_request_id', '=', CR_ID)
      .where('kind', '=', 'summary')
      .executeTakeFirst();
    expect(summaryRec?.state).toBe('published');

    // The trace context is set by buildEnv time; installation is the erasure lookup key.
    expect(traceAtBuildEnv).toMatchObject({
      tenantId: TENANT,
      installationId: INSTALL,
      repo: 'acme/app',
      stage: 'review',
    });
  });

  it('payload tenant/repository/revision/head 绑定不一致时在 buildEnv 前失败', async () => {
    let built = false;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async () => {
        built = true;
        throw new Error('must not build');
      },
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: 'wrong-head',
        configDigest: '',
      },
      maxAttempts: 1,
      dedupeKey: `review-invalid-binding-${uuidv7()}`,
    });
    await new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    }).runOnce();
    expect(built).toBe(false);
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

  it('reviews.auto.enabled=false → clone 前 gate 跳过(不 buildEnv/不发布)', async () => {
    // Stored effective config enabled=false (as mirrored from .winnowl.yaml by an earlier review).
    const settings = {
      reviews: {
        auto: { enabled: false, drafts: false, base_branches: ['main'], ignore_authors: [] },
      },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'd1',
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('repository_id')
          .doUpdateSet({ settings, config_digest: 'd1', updated_at: new Date() }),
      )
      .execute();

    let buildEnvCalled = false;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled = true;
        throw new Error('buildEnv 不应被调用(config gate 应先跳过)');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: HEAD,
        configDigest: '',
      },
      dedupeKey: 'review-gate-skip',
    });

    expect(await supervisor.runOnce()).toBe(true);
    const status = await db
      .selectFrom('jobs')
      .select('status')
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe('completed'); // a gate skip is a normal completion
    expect(buildEnvCalled).toBe(false);
  });

  // A PR merged or closed while queued is skipped silently (manual triggers are rejected earlier, in the conversation).
  it('change request 已合并/关闭 → gate 跳过(不 buildEnv,不烧模型)', async () => {
    const settings = {
      reviews: {
        auto: { enabled: true, drafts: false, base_branches: ['main'], ignore_authors: [] },
      },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'dm',
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('repository_id')
          .doUpdateSet({ settings, config_digest: 'dm', updated_at: new Date() }),
      )
      .execute();
    await db
      .updateTable('change_requests')
      .set({ state: 'merged' })
      .where('id', '=', CR_ID)
      .execute();

    let buildEnvCalled = false;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled = true;
        throw new Error('buildEnv 不应被调用(已合并的 CR 应先跳过)');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: HEAD,
        configDigest: '',
      },
      dedupeKey: 'review-merged-skip',
    });

    expect(await supervisor.runOnce()).toBe(true);
    const status = await db
      .selectFrom('jobs')
      .select('status')
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe('completed'); // a skip is a normal completion
    expect(buildEnvCalled).toBe(false);
    await db
      .updateTable('change_requests')
      .set({ state: 'open' })
      .where('id', '=', CR_ID)
      .execute();
  });

  it('reviews.auto.ignore_authors 命中作者 → clone 前 gate 跳过(§37)', async () => {
    const settings = {
      reviews: {
        auto: {
          enabled: true,
          drafts: false,
          base_branches: ['main'],
          ignore_authors: ['dependabot'],
        },
      },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'd2',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();
    await db
      .updateTable('change_requests')
      .set({ author: 'dependabot' })
      .where('id', '=', CR_ID)
      .execute();

    let buildEnvCalled = false;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled = true;
        throw new Error('buildEnv 不应被调用(ignore_authors gate 应先跳过)');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: HEAD,
        configDigest: '',
      },
      dedupeKey: 'review-ignore-author',
    });
    expect(await supervisor.runOnce()).toBe(true);
    const status = await db
      .selectFrom('jobs')
      .select('status')
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe('completed');
    expect(buildEnvCalled).toBe(false);
    // Restore for later tests.
    await db.updateTable('change_requests').set({ author: 'octocat' }).where('id', '=', CR_ID).execute();
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  /*
   * Bot-authored PRs. Our own are always skipped regardless of config, since they would loop
   * (post-merge / stacked fix PR → auto review → more bot PRs). Third-party bots are skipped by default, configurable.
   */
  const runGate = async (
    dedupeKey: string,
    payloadExtra: Record<string, unknown> = {},
  ): Promise<{ status: string; buildEnvCalled: boolean }> => {
    let buildEnvCalled = false;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled = true;
        throw new Error('buildEnv 不应被调用(gate 应先跳过)');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: HEAD,
        configDigest: '',
        ...payloadExtra,
      },
      dedupeKey,
    });
    await supervisor.runOnce();
    const row = await db
      .selectFrom('jobs')
      .select('status')
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    return { status: row.status, buildEnvCalled };
  };

  it('bot 自己开的 PR → 恒跳过自动 review(防自我循环),即便 ignore_bot_authors 关着', async () => {
    const settings = {
      reviews: {
        auto: {
          enabled: true,
          drafts: false,
          base_branches: ['main'],
          ignore_authors: [],
          ignore_bot_authors: false,
        },
      },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'd-own-bot',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();
    await db
      .updateTable('change_requests')
      .set({ author: 'winnowl[bot]', author_is_bot: true })
      .where('id', '=', CR_ID)
      .execute();

    expect(await runGate('review-own-bot')).toEqual({ status: 'completed', buildEnvCalled: false });

    await db
      .updateTable('change_requests')
      .set({ author: 'octocat', author_is_bot: null })
      .where('id', '=', CR_ID)
      .execute();
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  it('第三方 bot 的 PR → 默认跳过;ignore_bot_authors=false 时照常评审', async () => {
    await db
      .updateTable('change_requests')
      .set({ author: 'dependabot[bot]', author_is_bot: true })
      .where('id', '=', CR_ID)
      .execute();
    // Default (no repository_settings): ignore_bot_authors is on → skipped.
    expect(await runGate('review-thirdparty-bot-default')).toEqual({
      status: 'completed',
      buildEnvCalled: false,
    });

    // Turned off explicitly: reaches buildEnv (which throws here, proving the gate passed).
    const settings = {
      reviews: {
        auto: {
          enabled: true,
          drafts: false,
          base_branches: ['main'],
          ignore_authors: [],
          ignore_bot_authors: false,
        },
      },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'd-bot-off',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();
    const opened = await runGate('review-thirdparty-bot-off');
    expect(opened.buildEnvCalled).toBe(true);

    await db
      .updateTable('change_requests')
      .set({ author: 'octocat', author_is_bot: null })
      .where('id', '=', CR_ID)
      .execute();
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  it('forge 没说是不是 bot(author_is_bot=null)→ 退回 `[bot]` 后缀启发式', async () => {
    await db
      .updateTable('change_requests')
      .set({ author: 'renovate[bot]', author_is_bot: null })
      .where('id', '=', CR_ID)
      .execute();
    expect(await runGate('review-bot-suffix-heuristic')).toEqual({
      status: 'completed',
      buildEnvCalled: false,
    });

    // Undeterminable means human: no suffix and no forge flag → reviewed.
    await db
      .updateTable('change_requests')
      .set({ author: 'a-human', author_is_bot: null })
      .where('id', '=', CR_ID)
      .execute();
    expect((await runGate('review-unknown-author')).buildEnvCalled).toBe(true);

    await db.updateTable('change_requests').set({ author: 'octocat' }).where('id', '=', CR_ID).execute();
  });

  it('manual `@bot review` 不受 bot 作者影响 —— 人显式要求评审 bot 的 PR 是正当的', async () => {
    await db
      .updateTable('change_requests')
      .set({ author: 'winnowl[bot]', author_is_bot: true })
      .where('id', '=', CR_ID)
      .execute();
    expect((await runGate('review-own-bot-manual', { trigger: 'manual' })).buildEnvCalled).toBe(
      true,
    );
    await db
      .updateTable('change_requests')
      .set({ author: 'octocat', author_is_bot: null })
      .where('id', '=', CR_ID)
      .execute();
  });

  it('reviews.auto.required_labels 未命中 → gate 跳过;manual 触发绕过(§37,0034)', async () => {
    const settings = {
      reviews: {
        auto: {
          enabled: true,
          drafts: false,
          base_branches: ['main'],
          ignore_authors: [],
          required_labels: ['needs-review'],
        },
      },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'd3',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();

    let buildEnvCalled = 0;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled += 1;
        throw new Error('gate 验证到此为止(buildEnv 被调用即视为通过 gate)');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });

    // 1. No matching label (default []): the auto trigger is skipped.
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: HEAD,
        configDigest: '',
      },
      dedupeKey: 'review-labels-miss',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(0);

    // 2. Manual triggers bypass the required_labels gate (reach buildEnv).
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: HEAD,
        configDigest: '',
        trigger: 'manual',
      },
      dedupeKey: 'review-labels-manual',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(1);

    // 3. Matching label: the auto trigger passes.
    await db
      .updateTable('change_requests')
      .set({ labels: JSON.stringify(['needs-review', 'x']) })
      .where('id', '=', CR_ID)
      .execute();
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: HEAD,
        configDigest: '',
      },
      dedupeKey: 'review-labels-hit',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(2);

    await db
      .updateTable('change_requests')
      .set({ labels: JSON.stringify([]) })
      .where('id', '=', CR_ID)
      .execute();
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
    // The two jobs whose buildEnv threw are retried; finish them so later runOnce calls do not pick them up.
    await db
      .updateTable('jobs')
      .set({ status: 'failed' })
      .where('dedupe_key', 'in', ['review-labels-manual', 'review-labels-hit'])
      .execute();
  });

  it('stacked PR:base_branches 按 stack 归宿判定,不被下层分支挡掉(§26.7)', async () => {
    const settings = {
      reviews: {
        auto: { enabled: true, drafts: false, base_branches: ['main'], ignore_authors: [] },
      },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'stack',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();

    // Lower PR: base=main (stack root).
    const PARENT = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: PARENT,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '50',
        number: 50,
        kind: 'pull-request',
        author: 'octocat',
        source_branch: 'feat/layer-1',
        target_branch: 'main',
        state: 'open',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    // Upper PR: base=feat/layer-1, which is not in base_branches.
    const CHILD = uuidv7();
    const CHILD_REV = uuidv7();
    const CHILD_NATIVE_REV = uuidv7();
    const CHILD_MANUAL_REV = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: CHILD,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '51',
        number: 51,
        kind: 'pull-request',
        source_branch: 'feat/layer-2',
        target_branch: 'feat/layer-1',
        state: 'open',
        draft: false,
        author: 'octocat',
        stacked_on_change_request_id: PARENT,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values([
        {
          id: CHILD_REV,
          tenant_id: TENANT,
          change_request_id: CHILD,
          base_sha: 'b',
          head_sha: 'head-51',
          merge_base_sha: null,
          source_branch: 'feat/layer-2',
          target_branch: 'feat/layer-1',
          created_at: new Date(),
        },
        {
          id: CHILD_NATIVE_REV,
          tenant_id: TENANT,
          change_request_id: CHILD,
          base_sha: 'b',
          head_sha: 'head-51b',
          merge_base_sha: null,
          source_branch: 'feat/layer-2',
          target_branch: 'feat/layer-1',
          created_at: new Date(),
        },
        {
          id: CHILD_MANUAL_REV,
          tenant_id: TENANT,
          change_request_id: CHILD,
          base_sha: 'b',
          head_sha: 'head-51c',
          merge_base_sha: null,
          source_branch: 'feat/layer-2',
          target_branch: 'feat/layer-1',
          created_at: new Date(),
        },
      ])
      .execute();

    let buildEnvCalled = 0;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled += 1;
        throw new Error('gate 验证到此为止(buildEnv 被调用即视为通过 gate)');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });

    // 1. Topology: following stacked_on reaches the root target main → allowed.
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CHILD,
        revisionId: CHILD_REV,
        headSha: 'head-51',
        configDigest: '',
      },
      dedupeKey: 'stack-inferred',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(1);

    // 2. The native stack field wins over topology: stack target release/2.0 is not in base_branches → blocked.
    await db
      .updateTable('change_requests')
      .set({ stack_base_ref: 'release/2.0' })
      .where('id', '=', CHILD)
      .execute();
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CHILD,
        revisionId: CHILD_NATIVE_REV,
        headSha: 'head-51b',
        configDigest: '',
      },
      dedupeKey: 'stack-native',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(1); // not called again: blocked by the gate

    // 3. Manual always bypasses base_branches.
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CHILD,
        revisionId: CHILD_MANUAL_REV,
        headSha: 'head-51c',
        configDigest: '',
        trigger: 'manual',
      },
      dedupeKey: 'stack-manual',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(2);

    await db
      .updateTable('jobs')
      .set({ status: 'failed' })
      .where('dedupe_key', 'in', ['stack-inferred', 'stack-manual'])
      .execute();
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  it('change_requests.auto_review_paused(`@bot pause`)→ auto 跳过;manual 恒绕过且不解除(§26.4)', async () => {
    const CRP = uuidv7();
    const REVP = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: CRP,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '48',
        number: 48,
        kind: 'pull-request',
        source_branch: 'feature/p',
        target_branch: 'main',
        state: 'open',
        draft: false,
        author: 'octocat',
        auto_review_paused: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values({
        id: REVP,
        tenant_id: TENANT,
        change_request_id: CRP,
        base_sha: 'base-p',
        head_sha: 'head-48',
        merge_base_sha: null,
        source_branch: 'feature/p',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();

    let buildEnvCalled = 0;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled += 1;
        throw new Error('gate 验证到此为止(buildEnv 被调用即视为通过 gate)');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });

    // 1. Auto trigger: blocked by the pause flag, no clone/buildEnv.
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CRP,
        revisionId: REVP,
        headSha: 'head-48',
        configDigest: '',
      },
      dedupeKey: 'review-paused-auto',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(0);

    // 2. Manual (`@bot review`) bypasses the pause.
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CRP,
        revisionId: REVP,
        headSha: 'head-48',
        configDigest: '',
        trigger: 'manual',
      },
      dedupeKey: 'review-paused-manual',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(1);
    // 3. Manual does not lift the pause (needs an explicit `@bot resume`).
    expect(
      (
        await db
          .selectFrom('change_requests')
          .selectAll()
          .where('id', '=', CRP)
          .executeTakeFirstOrThrow()
      ).auto_review_paused,
    ).toBe(true);

    await db
      .updateTable('jobs')
      .set({ status: 'failed' })
      .where('dedupe_key', '=', 'review-paused-manual')
      .execute();
  });

  it('pause_after_reviewed_commits:自动 review 达 N 次 → 暂停;manual 重置窗口(§37)', async () => {
    // Separate CR: pause counting filters by changeRequestId.
    const CR2 = uuidv7();
    const REV2 = uuidv7();
    const REV_BLOCKED = uuidv7();
    const REV_RESET = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: CR2,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '43',
        number: 43,
        kind: 'pull-request',
        source_branch: 'feature/y',
        target_branch: 'main',
        state: 'open',
        draft: false,
        author: 'octocat',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values([
        {
          id: REV2,
          tenant_id: TENANT,
          change_request_id: CR2,
          base_sha: 'base-2',
          head_sha: 'head-43',
          merge_base_sha: null,
          source_branch: 'feature/y',
          target_branch: 'main',
          created_at: new Date(),
        },
        {
          id: REV_BLOCKED,
          tenant_id: TENANT,
          change_request_id: CR2,
          base_sha: 'base-2',
          head_sha: 'head-43-blocked',
          merge_base_sha: null,
          source_branch: 'feature/y',
          target_branch: 'main',
          created_at: new Date(),
        },
        {
          id: REV_RESET,
          tenant_id: TENANT,
          change_request_id: CR2,
          base_sha: 'base-2',
          head_sha: 'head-43-reset',
          merge_base_sha: null,
          source_branch: 'feature/y',
          target_branch: 'main',
          created_at: new Date(),
        },
      ])
      .execute();
    const settings = {
      reviews: {
        auto: {
          enabled: true,
          drafts: false,
          base_branches: ['main'],
          ignore_authors: [],
          pause_after_reviewed_commits: 1,
        },
      },
    } as unknown as Record<string, unknown>;
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings,
        config_digest: 'd4',
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
      .execute();

    let buildEnvCalled = 0;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled += 1;
        throw new Error('gate 验证到此为止');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5)); // keeps created_at ordered (ms resolution)

    // First a completed auto review job (counted toward the pause).
    const { jobId: doneId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR2,
        revisionId: REV2,
        headSha: 'head-43',
        configDigest: '',
      },
      dedupeKey: 'review-pause-done',
    });
    await db.updateTable('jobs').set({ status: 'completed' }).where('id', '=', doneId).execute();
    await db
      .insertInto('review_costs')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        repository_id: REPO,
        change_request_id: CR2,
        revision_id: REV2,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cost_usd: 0.01,
        candidate_count: 1,
        published_inline: 0,
        scopes_total: 1,
        scopes_complete: 1,
        cancelled: false,
        created_at: new Date(),
      })
      .execute();
    await tick();

    // 1. One completed ≥ N=1 → the auto trigger is paused (gate skip, job completes).
    const { jobId: blockedId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR2,
        revisionId: REV_BLOCKED,
        headSha: 'head-43-blocked',
        configDigest: '',
      },
      dedupeKey: 'review-pause-blocked',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(0);
    expect(
      (
        await db
          .selectFrom('jobs')
          .select('status')
          .where('id', '=', blockedId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('completed');
    await tick();

    // 2. A manual trigger ignores the pause (reaches buildEnv) and starts a new window.
    const { jobId: manualId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR2,
        revisionId: REV_BLOCKED,
        headSha: 'head-43-blocked',
        configDigest: '',
        trigger: 'manual',
      },
      dedupeKey: 'review-pause-manual',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(1);
    // The buildEnv failure puts the job into retry; finish it so later runOnce calls do not pick it up.
    await db.updateTable('jobs').set({ status: 'failed' }).where('id', '=', manualId).execute();
    await tick();

    // 3. After manual the window resets: auto passes again (earlier completions predate it).
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR2,
        revisionId: REV_RESET,
        headSha: 'head-43-reset',
        configDigest: '',
      },
      dedupeKey: 'review-pause-reset',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(2);

    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  it('同 revision 已评审(review_costs 行存在)→ auto 跳过、manual 绕过(自触发循环防护,2026-07-21)', async () => {
    // Explicit enabled=true: tests share REPO and earlier ones store enabled=false.
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings: { reviews: { auto: { enabled: true } } },
        config_digest: 'on',
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('repository_id')
          .doUpdateSet({ settings: { reviews: { auto: { enabled: true } } } }),
      )
      .execute();
    // Separate CR/revision so leftover jobs do not interfere.
    const CR3 = uuidv7();
    const REV3 = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: CR3,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '44',
        number: 44,
        kind: 'pull-request',
        source_branch: 'feature/z',
        target_branch: 'main',
        state: 'open',
        draft: false,
        author: 'octocat',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values({
        id: REV3,
        tenant_id: TENANT,
        change_request_id: CR3,
        base_sha: 'base-3',
        head_sha: 'head-44',
        merge_base_sha: null,
        source_branch: 'feature/z',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    // The revision already has a full-review cost row (gate-skipped jobs do not write one).
    await db
      .insertInto('review_costs')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        repository_id: REPO,
        change_request_id: CR3,
        revision_id: REV3,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cost_usd: 0.01,
        candidate_count: 1,
        published_inline: 0,
        scopes_total: 1,
        scopes_complete: 1,
        created_at: new Date(),
      })
      .execute();

    let buildEnvCalled = 0;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled += 1;
        throw new Error('guard 验证到此为止');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });

    // 1. Auto (a bot editing the body re-enqueues via `updated`) → the guard skips, job completes, no LLM.
    const { jobId: autoId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR3,
        revisionId: REV3,
        headSha: 'head-44',
        configDigest: '',
      },
      dedupeKey: 'review-rereview-auto',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(0);
    expect(
      (
        await db
          .selectFrom('jobs')
          .select('status')
          .where('id', '=', autoId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('completed');

    // 2. Manual re-review bypasses the guard (reaches buildEnv).
    const { jobId: manualId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR3,
        revisionId: REV3,
        headSha: 'head-44',
        configDigest: '',
        trigger: 'manual',
      },
      dedupeKey: 'review-rereview-manual',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(1);
    await db.updateTable('jobs').set({ status: 'failed' }).where('id', '=', manualId).execute();

    // A cancelled run's cost row does not count as reviewed, or one cancellation would block auto review of the revision forever.
    await db
      .updateTable('review_costs')
      .set({ cancelled: true })
      .where('revision_id', '=', REV3)
      .execute();
    const { jobId: afterCancelId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR3,
        revisionId: REV3,
        headSha: 'head-44',
        configDigest: '',
      },
      dedupeKey: 'review-rereview-after-cancel',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(2); // reaches buildEnv; not treated as reviewed
    await db
      .updateTable('jobs')
      .set({ status: 'failed' })
      .where('id', '=', afterCancelId)
      .execute();
  });

  it('a manual review of the revision in flight → auto skips (mark ready during `@bot review` must not review twice)', async () => {
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings: { reviews: { auto: { enabled: true } } },
        config_digest: 'on',
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('repository_id')
          .doUpdateSet({ settings: { reviews: { auto: { enabled: true } } } }),
      )
      .execute();
    const CR = uuidv7();
    const REV = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: CR,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '45',
        number: 45,
        kind: 'pull-request',
        source_branch: 'feature/ready',
        target_branch: 'main',
        state: 'open',
        draft: false,
        author: 'octocat',
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
        base_sha: 'base-45',
        head_sha: 'head-45',
        merge_base_sha: null,
        source_branch: 'feature/ready',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();

    let buildEnvCalled = 0;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled += 1;
        throw new Error('guard 验证到此为止');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    const payload = {
      tenantId: TENANT,
      repositoryId: REPO,
      changeRequestId: CR,
      revisionId: REV,
      headSha: 'head-45',
      configDigest: '',
    };

    // The manual run is mid-flight (claimed by another worker).
    const { jobId: manualId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: { ...payload, trigger: 'manual' },
      dedupeKey: 'review-inflight-manual',
    });
    await db.updateTable('jobs').set({ status: 'running' }).where('id', '=', manualId).execute();

    // ready_for_review arrives → auto job is skipped before clone.
    const { jobId: autoId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload,
      dedupeKey: 'review-inflight-auto',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(0);
    expect(
      (await db.selectFrom('jobs').select('status').where('id', '=', autoId).executeTakeFirstOrThrow()).status,
    ).toBe('completed');

    // Once the manual run has ended without a completed review, auto reviews again.
    await db.updateTable('jobs').set({ status: 'failed' }).where('id', '=', manualId).execute();
    const { jobId: autoAfterId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload,
      dedupeKey: 'review-inflight-auto-after',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(1);
    await db.updateTable('jobs').set({ status: 'failed' }).where('id', '=', autoAfterId).execute();
  });

  it('大变更成本闸(max_changed_files):auto 超限跳过、manual 绕过、取数失败不拦', async () => {
    const CR6 = uuidv7();
    const REV6 = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: CR6,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '47',
        number: 47,
        kind: 'pull-request',
        source_branch: 'feature/h',
        target_branch: 'main',
        state: 'open',
        draft: false,
        author: 'octocat',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values({
        id: REV6,
        tenant_id: TENANT,
        change_request_id: CR6,
        base_sha: 'base-6',
        head_sha: 'head-47',
        merge_base_sha: null,
        source_branch: 'feature/h',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings: { reviews: { auto: { enabled: true, max_changed_files: 100 } } },
        config_digest: 'cg',
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('repository_id')
          .doUpdateSet({
            settings: { reviews: { auto: { enabled: true, max_changed_files: 100 } } },
          }),
      )
      .execute();

    let buildEnvCalled = 0;
    let count: number | null = 917;
    const announced: unknown[] = [];
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled += 1;
        throw new Error('cost-gate 验证到此为止');
      },
      // 17 of 917 are lockfiles / generated code and not counted; 900 source files still exceed the limit.
      listChangedPaths: async () =>
        count === null
          ? null
          : [
              ...Array.from({ length: count - 17 }, (_, i) => `src/f${i}.ts`),
              ...Array.from({ length: 15 }, (_, i) => `lib/m${i}.g.dart`),
              'pnpm-lock.yaml',
              'vendor/x.go',
            ],
      onAutoReviewSkipped: async (_ctx, skip) => void announced.push(skip),
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    const enqueue = (key: string, trigger?: 'manual') =>
      enqueueJob(db, {
        tenantId: TENANT,
        type: 'review_revision',
        payload: {
          tenantId: TENANT,
          repositoryId: REPO,
          changeRequestId: CR6,
          revisionId: REV6,
          headSha: 'head-47',
          configDigest: '',
          ...(trigger ? { trigger } : {}),
        },
        dedupeKey: key,
      });

    // 1. Auto over the limit → skipped (no buildEnv), reason posted in the status comment.
    await enqueue('cg-auto-big');
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(0);
    expect(announced).toEqual([{ code: 'too-many-files', count: 900, limit: 100 }]);
    // 2. Manual bypasses (reaches buildEnv).
    const { jobId: m } = await enqueue('cg-manual', 'manual');
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(1);
    await db.updateTable('jobs').set({ status: 'failed' }).where('id', '=', m).execute();
    // 3. Lookup failure (null) → not blocked.
    count = null;
    const { jobId: n } = await enqueue('cg-auto-null');
    expect(await supervisor.runOnce()).toBe(true);
    expect(buildEnvCalled).toBe(2);
    await db.updateTable('jobs').set({ status: 'failed' }).where('id', '=', n).execute();
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  it('yaml 开启滞后死锁(§37 gate 复核):落库 enabled=false 但 repo yaml 开启 → 放行;无 yaml → 仍跳过', async () => {
    const CR5 = uuidv7();
    const REV5 = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: CR5,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '46',
        number: 46,
        kind: 'pull-request',
        source_branch: 'feature/g',
        target_branch: 'main',
        state: 'open',
        draft: false,
        author: 'octocat',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values({
        id: REV5,
        tenant_id: TENANT,
        change_request_id: CR5,
        base_sha: 'base-5',
        head_sha: 'head-46',
        merge_base_sha: null,
        source_branch: 'feature/g',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    // Stored config (mirrored by an earlier review): enabled=false, now stale.
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings: { reviews: { auto: { enabled: false } } },
        config_digest: 'stale',
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('repository_id')
          .doUpdateSet({ settings: { reviews: { auto: { enabled: false } } } }),
      )
      .execute();

    let buildEnvCalled = 0;
    let recheckCalled = 0;
    let yamlFragment: Record<string, unknown> | null = { enabled: true };
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        buildEnvCalled += 1;
        throw new Error('recheck 验证到此为止');
      },
      recheckAutoFromRepoFile: async () => {
        recheckCalled += 1;
        return yamlFragment;
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });

    // 1. The yaml enables it → the recheck passes (reaches buildEnv).
    const { jobId: j1 } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR5,
        revisionId: REV5,
        headSha: 'head-46',
        configDigest: '',
      },
      dedupeKey: 'review-recheck-open',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(recheckCalled).toBe(1);
    expect(buildEnvCalled).toBe(1);
    await db.updateTable('jobs').set({ status: 'failed' }).where('id', '=', j1).execute();

    // 2. No yaml (null) → the gate still skips (no LLM).
    yamlFragment = null;
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR5,
        revisionId: REV5,
        headSha: 'head-46',
        configDigest: '',
      },
      dedupeKey: 'review-recheck-none',
    });
    expect(await supervisor.runOnce()).toBe(true);
    expect(recheckCalled).toBe(2);
    expect(buildEnvCalled).toBe(1); // buildEnv not reached again
    await db.deleteFrom('repository_settings').where('repository_id', '=', REPO).execute();
  });

  it('配额/熔断挡下 → **必须给 PR 一个说得清的回执**(此前只写日志,PR 上什么都不出现)', async () => {
    const blocked: { reason: string }[] = [];
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      quotaGate: async () => ({
        block: true,
        reason: 'review_quota_exceeded',
        reasonCode: 'review_quota',
      }),
      onBlocked: async (_ctx, reason) => {
        blocked.push({ reason });
      },
      // The block happens before buildEnv; a call here means the gate failed.
      buildEnv: async () => {
        throw new Error('buildEnv 不该被调用:配额已挡下');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: HEAD,
        configDigest: '',
      },
      dedupeKey: 'review-quota-block-1',
    });

    expect(await supervisor.runOnce()).toBe(true);
    // The job completes (a block is not a failure) with a typed-reason reply.
    expect(
      (
        await db
          .selectFrom('jobs')
          .select('status')
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('completed');
    expect(blocked).toEqual([{ reason: 'review_quota' }]);
  });

  // A non-retryable error on an earlier attempt must also fire the terminal-failure ack, or the check-run
  // and status comment stay "reviewing" forever.
  it('不可重试的失败(墙钟到点且零候选)在第一次尝试就终态 + 回执;可重试的失败不回执、重排队', async () => {
    const terminal: string[] = [];
    let nextError: Error = new Error('unset');
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      onTerminalFailure: async (_ctx, error) => {
        terminal.push((error as Error).message);
      },
      buildEnv: async () => {
        throw nextError;
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    const run = async (dedupeKey: string, error: Error) => {
      nextError = error;
      const { jobId } = await enqueueJob(db, {
        tenantId: TENANT,
        type: 'review_revision',
        payload: {
          tenantId: TENANT,
          repositoryId: REPO,
          changeRequestId: CR_ID,
          revisionId: REVISION_ID,
          headSha: HEAD,
          configDigest: '',
          trigger: 'manual',
        },
        dedupeKey,
        maxAttempts: 4,
      });
      expect(await supervisor.runOnce()).toBe(true);
      return db
        .selectFrom('jobs')
        .select(['status', 'last_error'])
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow();
    };

    const cut = await run(
      'review-deadline-cut',
      Object.assign(new Error('deadline cut'), {
        name: 'ReviewIncompleteError',
        failureKind: 'timeout',
        deadlineCut: true,
      }),
    );
    expect(cut.status).toBe('failed');
    expect((cut.last_error as { class?: string }).class).toBe('budget_exhausted');
    expect(terminal).toEqual(['deadline cut']);

    const gateway = await run(
      'review-gateway-flake',
      Object.assign(new Error('gateway flake'), {
        name: 'ReviewIncompleteError',
        failureKind: 'gateway_transport',
      }),
    );
    expect(gateway.status).toBe('queued');
    expect(terminal).toEqual(['deadline cut']);

    // Finish the requeued job so later runOnce calls do not pick it up.
    await db
      .updateTable('jobs')
      .set({ status: 'failed' })
      .where('dedupe_key', '=', 'review-gateway-flake')
      .execute();
  });

  it('回执失败不能反过来让 review 跑起来(挡下这个事实不受回执影响)', async () => {
    let builtEnv = false;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      quotaGate: async () => ({
        block: true,
        reason: 'daily_cost_cap',
        reasonCode: 'daily_cost_cap',
      }),
      onBlocked: async () => {
        throw new Error('provider 挂了');
      },
      buildEnv: async () => {
        builtEnv = true;
        throw new Error('不该到这');
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        headSha: HEAD,
        configDigest: '',
      },
      dedupeKey: 'review-quota-block-2',
    });

    expect(await supervisor.runOnce()).toBe(true);
    expect(builtEnv).toBe(false);
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

  it('§10.7 在途被新 Head 取代 → 提前收工:不发布、不走发布后置链,但仍 onCancelled 记账', async () => {
    // Explicit enabled=true: tests share REPO and earlier ones store enabled=false.
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings: { reviews: { auto: { enabled: true } } },
        config_digest: 'on',
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('repository_id')
          .doUpdateSet({ settings: { reviews: { auto: { enabled: true } } } }),
      )
      .execute();
    await db
      .updateTable('change_requests')
      .set({ author: 'octocat' })
      .where('id', '=', CR_ID)
      .execute();

    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [
        faux.assistant(
          faux.toolCall('submit_plan', {
            scopes: [
              {
                title: 'add()',
                changeSummary: 'add',
                obligations: [{ kind: 'correctness', description: 'sum correct' }],
              },
            ],
          }),
        ),
      ],
      complete_section: [
        faux.assistant(
          faux.toolCall('submit_finding', {
            claim: 'off-by-one in add',
            category: 'correctness',
            suspectedSeverity: 'high',
            path: 'app.py',
            primaryAnchorText: 'return a + b',
            changeRelationHypothesis: 'introduced',
          }),
        ),
        faux.assistant(
          faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }),
        ),
      ],
      submit_summary: [
        faux.assistant(faux.toolCall('submit_summary', { note: 'no cross-scope issues' })),
      ],
      submit_assessment: [
        faux.assistant(
          faux.toolCall('submit_assessment', {
            decision: 'accept',
            introducedByChange: true,
            reachable: true,
            actionable: true,
            changeRelation: 'introduced',
            severity: 'high',
            confirmation: 'independently-verified',
            residualUncertainty: [],
          }),
        ),
      ],
      confirm_assessment: [
        faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] })),
      ],
    });

    const REV_CANCEL = uuidv7();
    const HEAD_CANCEL = `head-cancel-${REV_CANCEL}`;
    await db
      .insertInto('revisions')
      .values({
        id: REV_CANCEL,
        tenant_id: TENANT,
        change_request_id: CR_ID,
        base_sha: 'base-cancel',
        head_sha: HEAD_CANCEL,
        merge_base_sha: null,
        source_branch: 'feature/x',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REV_CANCEL,
        headSha: HEAD_CANCEL,
        configDigest: '',
      },
      dedupeKey: 'review-cancel-midflight',
    });

    const cancelledOutcomes: { candidateCount: number }[] = [];
    let onOutcomeCalls = 0;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      // A new head arrives after the review started: supersedeOlderReviewJobs flags the in-flight job.
      buildEnv: async (): Promise<ReviewEnv> => {
        await db
          .updateTable('jobs')
          .set({ cancellation_requested: true })
          .where('id', '=', jobId)
          .execute();
        return {
          source,
          model: faux.model,
          streamFn: faux.streamFn,
          bundles,
          budget: { maxTurns: 8, maxToolCalls: 16 },
          readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
          isChangedLine: () => true,
          publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD_CANCEL },
          noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
        };
      },
      onOutcome: async () => {
        onOutcomeCalls += 1;
      },
      onCancelled: async (outcome) => {
        cancelledOutcomes.push({ candidateCount: outcome.candidateCount });
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });

    expect(await supervisor.runOnce()).toBe(true);

    // Cancellation is a normal end (no failure, no retry of the old head) and keeps the superseded flag.
    expect(
      (
        await db
          .selectFrom('jobs')
          .select('status')
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('superseded');
    // Accounting goes through onCancelled; post-publish steps (findings/issue/check/proposals) do not run.
    expect(cancelledOutcomes).toHaveLength(1);
    expect(onOutcomeCalls).toBe(0);
    // Nothing from the old head is published.
    expect(discussions.comments).toHaveLength(0);
    expect(discussions.topLevel).toHaveLength(0);
    expect(
      await db
        .selectFrom('publication_records')
        .select('id')
        .where('change_request_id', '=', CR_ID)
        .where('revision_id', '=', REV_CANCEL)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  /*
   * Unlike supersede (a DB flag), an abort signal (shutdown / lease loss) means the run neither published
   * nor reruns itself, so the handler must throw: a normal return would be recorded as completed.
   */
  it('abort 信号中断的 review 抛错,不被记成完成(与新 Head 取代区分)', async () => {
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings: { reviews: { auto: { enabled: true } } },
        config_digest: 'on',
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('repository_id')
          .doUpdateSet({ settings: { reviews: { auto: { enabled: true } } } }),
      )
      .execute();
    await db
      .updateTable('change_requests')
      .set({ author: 'octocat' })
      .where('id', '=', CR_ID)
      .execute();

    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [
        faux.assistant(
          faux.toolCall('submit_plan', {
            scopes: [
              {
                title: 'add()',
                changeSummary: 'add',
                obligations: [{ kind: 'correctness', description: 'sum correct' }],
              },
            ],
          }),
        ),
      ],
      complete_section: [
        faux.assistant(
          faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }),
        ),
      ],
      submit_summary: [
        faux.assistant(faux.toolCall('submit_summary', { note: 'no cross-scope issues' })),
      ],
    });

    const REV_ABORT = uuidv7();
    const HEAD_ABORT = `head-abort-${REV_ABORT}`;
    await db
      .insertInto('revisions')
      .values({
        id: REV_ABORT,
        tenant_id: TENANT,
        change_request_id: CR_ID,
        base_sha: 'base-abort',
        head_sha: HEAD_ABORT,
        merge_base_sha: null,
        source_branch: 'feature/x',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR_ID,
        revisionId: REV_ABORT,
        headSha: HEAD_ABORT,
        configDigest: '',
      },
      dedupeKey: 'review-abort-midflight',
    });

    // The handler is built before the supervisor it references: join them through a mutable slot.
    const running: { supervisor?: Supervisor } = {};
    let onOutcomeCalls = 0;
    const handler = createReviewRevisionHandler({
      newId: () => uuidv7(),
      buildEnv: async (): Promise<ReviewEnv> => {
        // Shutdown / lease loss: abort fires mid-review.
        running.supervisor?.abortInFlight();
        return {
          source,
          model: faux.model,
          streamFn: faux.streamFn,
          bundles,
          budget: { maxTurns: 8, maxToolCalls: 16 },
          readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
          isChangedLine: () => true,
          publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD_ABORT },
          noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
        };
      },
      onOutcome: async () => {
        onOutcomeCalls += 1;
      },
    });
    const supervisor = new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { review_revision: handler },
    });
    running.supervisor = supervisor;

    expect(await supervisor.runOnce()).toBe(true);
    const status = async (): Promise<string> =>
      (
        await db
          .selectFrom('jobs')
          .select('status')
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow()
      ).status;
    // Neither completed nor superseded: the interrupted run stays leased until shutdown requeues it.
    expect(await status()).toBe('running');
    expect(onOutcomeCalls).toBe(0);
    expect(discussions.comments).toHaveLength(0);

    expect(await supervisor.releaseInFlight([jobId])).toBe(1);
    expect(await status()).toBe('queued');
    expect(
      (
        await db
          .selectFrom('jobs')
          .select('attempt_count')
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow()
      ).attempt_count,
    ).toBe(0);
  });
});
