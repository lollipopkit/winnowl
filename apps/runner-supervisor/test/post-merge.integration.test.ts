import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createPostMergeHandler, type PostMergeActionContext } from '../src/post-merge.js';
import { createPostMergeExecutor } from '../src/post-merge-executor.js';
import { Supervisor } from '../src/supervisor.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const noopSandbox = {
  create: async () => ({ id: 's', containerId: 'c' }),
  exec: async () => {
    throw new Error('x');
  },
  putFile: async () => undefined,
  getArtifact: async () => ({ path: '', content: '', bytes: 0 }),
  destroy: async () => undefined,
} as unknown as SandboxBackend;

/** One number per CR: (kind, number) is unique within a repository. */
let crNumber = 100;

describe('post_merge_action handler', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let workerId: string;
  const executed: PostMergeActionContext[] = [];

  beforeAll(async () => {
    // post-merge is disabled platform-wide; tests must enable it to run actions.
    process.env.POST_MERGE_ENABLED = '1';
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
    // post_merge is off by default; enable it explicitly.
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings: { actions: { post_merge: { enabled: true } } } as unknown as Record<
          string,
          unknown
        >,
        config_digest: 'c',
        updated_at: new Date(),
      })
      .execute();
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  });

  afterAll(async () => {
    delete process.env.POST_MERGE_ENABLED;
    await stop?.();
  });

  function supervisor(): Supervisor {
    const handler = createPostMergeHandler({
      enabledActions: ['create-follow-up-issue', 'notify-related-repo'],
      executeAction: async (ctx) => {
        executed.push(ctx);
      },
    });
    return new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { post_merge_action: handler },
    });
  }

  async function run(targetBranch: string, dedupe: string): Promise<void> {
    const cr = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: cr,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: dedupe,
        number: (crNumber += 1),
        kind: 'pull-request',
        source_branch: 'feat',
        target_branch: targetBranch,
        state: 'merged',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'post_merge_action',
      payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: cr },
      dedupeKey: dedupe,
    });
    executed.length = 0;
    await supervisor().runOnce();
  }

  it('默认分支 merge → 执行 follow-up 动作', async () => {
    await run('main', 'pm-1');
    expect(executed.map((c) => c.action.kind).sort()).toEqual([
      'create-follow-up-issue',
      'notify-related-repo',
    ]);
  });

  it('changedFiles 接线(§34):契约面变更 → refresh-generated-client 命中;无契约变更 → 跳过', async () => {
    const withFiles = (files: string[]): Supervisor =>
      new Supervisor({
        db,
        sandbox: noopSandbox,
        workerId,
        handlers: {
          post_merge_action: createPostMergeHandler({
            enabledActions: [
              'create-follow-up-issue',
              'refresh-generated-client',
              'run-migration-validation',
            ],
            executeAction: async (ctx) => {
              executed.push(ctx);
            },
            listChangedFiles: async () => files,
          }),
        },
      });

    const runWith = async (files: string[], dedupe: string): Promise<void> => {
      const cr = uuidv7();
      await db
        .insertInto('change_requests')
        .values({
          id: cr,
          tenant_id: TENANT,
          repository_id: REPO,
          native_id: dedupe,
          number: (crNumber += 1),
          kind: 'pull-request',
          source_branch: 'feat',
          target_branch: 'main',
          state: 'merged',
          draft: false,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
      await enqueueJob(db, {
        tenantId: TENANT,
        type: 'post_merge_action',
        payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: cr },
        dedupeKey: dedupe,
      });
      executed.length = 0;
      await withFiles(files).runOnce();
    };

    await runWith(['api/openapi.yaml', 'migrations/0001_init.sql'], 'pm-files-1');
    expect(executed.map((c) => c.action.kind).sort()).toEqual([
      'create-follow-up-issue',
      'refresh-generated-client',
      'run-migration-validation',
    ]);

    await runWith(['src/app.ts'], 'pm-files-2');
    expect(executed.map((c) => c.action.kind)).toEqual(['create-follow-up-issue']);
  });

  it('listChangedFiles 抛错 → 退回空集,不让 job 失败', async () => {
    const cr = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: cr,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: 'pm-files-err',
        number: (crNumber += 1),
        kind: 'pull-request',
        source_branch: 'feat',
        target_branch: 'main',
        state: 'merged',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'post_merge_action',
      payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: cr },
      dedupeKey: 'pm-files-err',
    });
    executed.length = 0;
    await new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: {
        post_merge_action: createPostMergeHandler({
          enabledActions: ['create-follow-up-issue', 'refresh-generated-client'],
          executeAction: async (ctx) => {
            executed.push(ctx);
          },
          listChangedFiles: async () => {
            throw new Error('provider down');
          },
        }),
      },
    }).runOnce();
    expect(executed.map((c) => c.action.kind)).toEqual(['create-follow-up-issue']);
    const job = await db
      .selectFrom('jobs')
      .select('status')
      .where('dedupe_key', '=', 'pm-files-err')
      .executeTakeFirst();
    expect(job?.status).toBe('completed');
  });

  it('非默认分支 merge → 不执行', async () => {
    await run('feature/x', 'pm-2');
    expect(executed).toHaveLength(0);
  });

  it('payload repository 与 CR 不匹配时拒绝执行', async () => {
    const otherRepo = uuidv7();
    await db
      .insertInto('repositories')
      .values({
        id: otherRepo,
        tenant_id: TENANT,
        provider_host_id: HOST,
        installation_id: INSTALL,
        native_id: `other-${otherRepo}`,
        namespace: 'acme',
        name: 'other',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    const cr = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: cr,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: `pm-mismatch-${cr}`,
        number: 11,
        kind: 'pull-request',
        source_branch: 'feat',
        target_branch: 'main',
        state: 'merged',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'post_merge_action',
      payload: { tenantId: TENANT, repositoryId: otherRepo, changeRequestId: cr },
      maxAttempts: 1,
      dedupeKey: `pm-mismatch-${cr}`,
    });
    executed.length = 0;
    await supervisor().runOnce();
    expect(executed).toHaveLength(0);
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

  it('平台级下线(POST_MERGE_ENABLED 未设)→ 仓库配置开着也不跑', async () => {
    delete process.env.POST_MERGE_ENABLED;
    try {
      await run('main', 'pm-platform-off');
      expect(executed).toHaveLength(0);
    } finally {
      process.env.POST_MERGE_ENABLED = '1';
    }
  });

  it('actions.post_merge.enabled=false → clone/动作前 gate 跳过(§37)', async () => {
    await db
      .updateTable('repository_settings')
      .set({
        settings: { actions: { post_merge: { enabled: false } } } as unknown as Record<
          string,
          unknown
        >,
      })
      .where('repository_id', '=', REPO)
      .execute();
    await run('main', 'pm-disabled');
    expect(executed).toHaveLength(0); // disabled in config: nothing executed
    await db
      .updateTable('repository_settings')
      .set({
        settings: { actions: { post_merge: { enabled: true } } } as unknown as Record<
          string,
          unknown
        >,
      })
      .where('repository_id', '=', REPO)
      .execute();
  });

  it('执行器:create-follow-up-issue → issues.create;改代码/跨仓动作显式失败', async () => {
    const created: { title: string; key: string }[] = [];
    const provider = {
      issues: {
        create: async (_r: unknown, input: { title: string }, idem: { key: string }) => {
          created.push({ title: input.title, key: idem.key });
          return { ref: { id: uuidv7(), repositoryId: REPO, nativeId: '1', number: 1 } };
        },
      },
    } as unknown as SourceControlProvider;
    const exec = createPostMergeExecutor({ buildProvider: async () => provider });
    const cr = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: cr,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: 'pm-exec',
        number: 5,
        kind: 'pull-request',
        source_branch: 'feat',
        target_branch: 'main',
        state: 'merged',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    await exec({
      action: { kind: 'create-follow-up-issue', deliversViaNewChangeRequest: false, reason: 'ci' },
      repositoryId: REPO,
      changeRequestId: cr,
      db,
      changedFiles: [],
    });
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe('Follow-up after #5');
    expect(created[0]!.key).toBe(`post-merge-issue:${cr}:create-follow-up-issue`);

    await expect(
      exec({
        action: { kind: 'update-docs', deliversViaNewChangeRequest: true, reason: 'docs' },
        repositoryId: REPO,
        changeRequestId: cr,
        db,
        changedFiles: [],
      }),
    ).rejects.toThrow(/未接线/);
  });

  it('执行器:注入 model/git 运行时后,代码修改动作走新 CR 路径(model 缺失 → 显式模型错)', async () => {
    const provider = {
      issues: {
        create: async () => ({
          ref: { id: uuidv7(), repositoryId: REPO, nativeId: '1', number: 1 },
        }),
      },
    } as unknown as SourceControlProvider;
    // deps are injected but modelSource returns null, so the model-source check fires (proves the new-CR branch ran).
    const exec = createPostMergeExecutor({
      buildProvider: async () => provider,
      openRepository: async () => {
        throw new Error('the model check comes first');
      },
      modelSource: () => null,
    });
    const cr = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: cr,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: 'pm-cr',
        number: 9,
        kind: 'pull-request',
        source_branch: 'feat',
        target_branch: 'main',
        state: 'merged',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await expect(
      exec({
        action: { kind: 'update-docs', deliversViaNewChangeRequest: true, reason: 'log' },
        repositoryId: REPO,
        changeRequestId: cr,
        db,
        changedFiles: [],
      }),
    ).rejects.toThrow(/需模型来源/);
  });
});
