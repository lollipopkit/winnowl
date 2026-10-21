import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { buildAdapters, createDbContextResolver } from '../src/context.js';
import { WebhookIngestor } from '../src/ingestor.js';
import { buildWebhookIngress } from '../src/server.js';
import type { IngestInput } from '../src/types.js';

const SECRET = 'shh';
const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
}

function githubBody(
  action = 'opened',
  headSha = 'aaaa',
  previousHeadSha?: string,
  updatedAt?: string,
): string {
  return JSON.stringify({
    action,
    ...(previousHeadSha ? { before: previousHeadSha, after: headSha } : {}),
    installation: { id: 999 },
    pull_request: {
      id: 5001,
      number: 42,
      draft: false,
      ...(updatedAt ? { updated_at: updatedAt } : {}),
      head: { sha: headSha, ref: 'feature/x', repo: { id: 900, private: false } },
      base: { sha: 'bbbb', ref: 'main', repo: { id: 900 } },
      requested_reviewers:
        action === 'review_request_removed' ? [] : [{ id: 8, login: 'bob', type: 'User' }],
    },
    repository: {
      id: 900,
      name: 'app',
      default_branch: 'main',
      clone_url: 'x',
      owner: { login: 'acme' },
    },
    sender: { id: 7, login: 'alice', type: 'User' },
  });
}

function installationBody(action = 'created'): string {
  return JSON.stringify({ action, installation: { id: 999 } });
}

function pushBody(ref: string, after: string, before = 'aaaa'): string {
  return JSON.stringify({
    installation: { id: 999 },
    ref,
    before,
    after,
    repository: {
      id: 900,
      name: 'app',
      default_branch: 'main',
      clone_url: 'x',
      owner: { login: 'acme' },
    },
    sender: { id: 7, login: 'alice', type: 'User' },
  });
}

function workflowRunBody(conclusion: string, headSha = 'aaaa'): string {
  return JSON.stringify({
    action: 'completed',
    installation: { id: 999 },
    workflow_run: { id: 8800, head_sha: headSha, status: 'completed', conclusion },
    repository: {
      id: 900,
      name: 'app',
      default_branch: 'main',
      clone_url: 'x',
      owner: { login: 'acme' },
    },
    sender: { id: 7, login: 'ci', type: 'Bot' },
  });
}

function ghInput(
  body: string,
  deliveryId: string,
  signature = sign(body),
  event = 'pull_request',
): IngestInput {
  return {
    provider: 'github',
    headers: {
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature,
      'content-type': 'application/json',
    },
    body,
    receivedAt: '2026-07-15T00:00:00.000Z',
  };
}

async function conversationPayloadOf(
  db: Db,
  actorLogin: string,
): Promise<{ actorLogin?: string; actorIsBot?: boolean } | undefined> {
  const rows = await db
    .selectFrom('jobs')
    .selectAll()
    .where('type', '=', 'conversation_turn')
    .execute();
  return rows
    .map((r) => r.payload as { actorLogin?: string; actorIsBot?: boolean })
    .filter((p) => p.actorLogin === actorLogin)
    .at(-1);
}

async function reviewJobsFor(
  db: Db,
  changeRequestId: string,
): Promise<{ status: string; headSha: string }[]> {
  const rows = await db
    .selectFrom('jobs')
    .selectAll()
    .where('type', '=', 'review_revision')
    .execute();
  return rows
    .map((r) => ({
      status: r.status,
      payload: r.payload as { changeRequestId?: string; headSha?: string },
    }))
    .filter((r) => r.payload.changeRequestId === changeRequestId)
    .map((r) => ({ status: r.status, headSha: r.payload.headSha ?? '' }));
}

describe('webhook-ingress 全链路', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let ingestor: WebhookIngestor;

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

    ingestor = new WebhookIngestor({
      db,
      adapters: buildAdapters(),
      resolveContext: createDbContextResolver(db),
      resolveSecret: async () => SECRET,
    });
  });

  afterAll(async () => {
    await stop?.();
  });

  it('验签→落原始事件→归一化→解析 CR/Revision', async () => {
    const body = githubBody('opened');
    const result = await ingestor.handle(ghInput(body, 'delivery-A'));
    expect(result.status).toBe('accepted');

    const rawCount = await db
      .selectFrom('provider_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('dedupe_key', '=', 'github:' + HOST + ':delivery-A')
      .executeTakeFirstOrThrow();
    expect(Number(rawCount.n)).toBe(1);

    const de = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('type', '=', 'change-request.opened')
      .executeTakeFirst();
    expect(de?.repository_id).toBe(REPO);
    expect(de?.change_request_id).toBeTruthy();

    const cr = await db
      .selectFrom('change_requests')
      .selectAll()
      .where('repository_id', '=', REPO)
      .executeTakeFirst();
    expect(cr?.number).toBe(42);
    expect(cr?.state).toBe('open');
    expect(cr?.author).toBe('alice');
    expect(cr?.author_provider_id).toBe('7');
    expect(cr?.reviewers).toEqual([{ providerUserId: '8', login: 'bob' }]);

    const rev = await db
      .selectFrom('revisions')
      .selectAll()
      .where('change_request_id', '=', cr!.id)
      .executeTakeFirst();
    expect(rev?.head_sha).toBe('aaaa');
    expect(rev?.base_sha).toBe('bbbb');
  });

  it('opened → 入队 review_revision(§9 → §10;payload 带 revisionId/headSha)', async () => {
    const cr = await db
      .selectFrom('change_requests')
      .selectAll()
      .where('repository_id', '=', REPO)
      .executeTakeFirstOrThrow();
    const jobs = await reviewJobsFor(db, cr.id);
    const queued = jobs.filter((j) => j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.headSha).toBe('aaaa');
    const raw = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'review_revision')
      .where('status', '=', 'queued')
      .executeTakeFirstOrThrow();
    expect((raw.payload as { revisionId?: string }).revisionId).toBeTruthy();
  });

  it('webhook 事件按 forge 设置刷新仓库默认分支', async () => {
    const defaultBranch = async () =>
      (await db.selectFrom('repositories').select('default_branch').where('id', '=', REPO).executeTakeFirstOrThrow())
        .default_branch;
    const renamed = (branch: string) => {
      const body = JSON.parse(pushBody('refs/heads/feature/y', 'dddd')) as { repository: { default_branch: string } };
      body.repository.default_branch = branch;
      return JSON.stringify(body);
    };
    const trunk = renamed('trunk');
    await ingestor.handle(ghInput(trunk, 'delivery-default-branch-1', sign(trunk), 'push'));
    expect(await defaultBranch()).toBe('trunk');
    const main = renamed('main');
    await ingestor.handle(ghInput(main, 'delivery-default-branch-2', sign(main), 'push'));
    expect(await defaultBranch()).toBe('main');
  });

  it('新 Head(synchronize)→ supersede 旧 review + 入队新 Head', async () => {
    const body = githubBody('synchronize', 'cccc', 'aaaa');
    const result = await ingestor.handle(ghInput(body, 'delivery-SYNC'));
    expect(result.status).toBe('accepted');
    expect(result.status === 'accepted' && result.scheduledJobIds.length).toBe(1);

    const cr = await db
      .selectFrom('change_requests')
      .selectAll()
      .where('repository_id', '=', REPO)
      .executeTakeFirstOrThrow();
    const jobs = await reviewJobsFor(db, cr.id);
    // Old head aaaa superseded; new head cccc queued.
    expect(jobs.find((j) => j.headSha === 'aaaa')?.status).toBe('superseded');
    expect(jobs.find((j) => j.headSha === 'cccc')?.status).toBe('queued');
    // updated events also backfill source/target branch.
    expect(cr.source_branch).toBe('feature/x');
    expect(cr.target_branch).toBe('main');
    const rev = await db
      .selectFrom('revisions')
      .selectAll()
      .where('change_request_id', '=', cr.id)
      .where('head_sha', '=', 'cccc')
      .executeTakeFirstOrThrow();
    expect(rev.source_branch).toBe('feature/x');
    expect(rev.target_branch).toBe('main');
  });

  it('乱序 Head 事件不会让较旧 revision 反向 supersede 新 review', async () => {
    const newer = await ingestor.handle(
      ghInput(githubBody('synchronize', 'ffff', 'eeee'), 'delivery-OOO-NEW'),
    );
    expect(newer.status).toBe('accepted');
    expect(newer.status === 'accepted' ? newer.scheduledJobIds : []).toHaveLength(1);

    const older = await ingestor.handle(
      ghInput(githubBody('synchronize', 'eeee', 'cccc'), 'delivery-OOO-OLD'),
    );
    expect(older.status).toBe('accepted');
    expect(older.status === 'accepted' ? older.scheduledJobIds : []).toHaveLength(0);

    const cr = await db
      .selectFrom('change_requests')
      .select('id')
      .where('repository_id', '=', REPO)
      .executeTakeFirstOrThrow();
    const jobs = await reviewJobsFor(db, cr.id);
    expect(jobs.find((job) => job.headSha === 'ffff')?.status).toBe('queued');
    expect(jobs.some((job) => job.headSha === 'eeee')).toBe(false);
  });

  it('provider 时间较旧的延迟 lifecycle 事件不会回退 CR 状态或触发旧副作用', async () => {
    const opened = JSON.parse(
      githubBody('opened', 'lifecycle-head', undefined, '2026-07-15T10:00:00.000Z'),
    ) as Record<string, unknown>;
    (opened.pull_request as { id: number; number: number }).id = 5101;
    (opened.pull_request as { id: number; number: number }).number = 51;
    expect(
      (await ingestor.handle(ghInput(JSON.stringify(opened), 'delivery-LIFECYCLE-OPEN'))).status,
    ).toBe('accepted');

    const merged = structuredClone(opened) as Record<string, unknown>;
    merged.action = 'closed';
    Object.assign(merged.pull_request as Record<string, unknown>, {
      merged: true,
      merge_commit_sha: 'merge-51',
      updated_at: '2026-07-15T12:00:00.000Z',
    });
    expect(
      (await ingestor.handle(ghInput(JSON.stringify(merged), 'delivery-LIFECYCLE-MERGE'))).status,
    ).toBe('accepted');

    const delayedReopen = structuredClone(opened) as Record<string, unknown>;
    delayedReopen.action = 'reopened';
    Object.assign(delayedReopen.pull_request as Record<string, unknown>, {
      updated_at: '2026-07-15T11:00:00.000Z',
    });
    const delayed = await ingestor.handle(
      ghInput(JSON.stringify(delayedReopen), 'delivery-LIFECYCLE-DELAYED'),
    );
    expect(delayed.status).toBe('accepted');
    expect(delayed.status === 'accepted' ? delayed.scheduledJobIds : []).toEqual([]);

    expect(
      await db
        .selectFrom('change_requests')
        .select('state')
        .where('repository_id', '=', REPO)
        .where('native_id', '=', '5101')
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'merged' });
  });

  it('provider 时间相同的 lifecycle 事件按 terminal precedence 稳定排序', async () => {
    const opened = JSON.parse(
      githubBody('opened', 'tie-head', undefined, '2026-07-15T13:00:00.000Z'),
    ) as Record<string, unknown>;
    (opened.pull_request as { id: number; number: number }).id = 5102;
    (opened.pull_request as { id: number; number: number }).number = 52;
    await ingestor.handle(ghInput(JSON.stringify(opened), 'delivery-TIE-OPEN'));

    const merged = structuredClone(opened) as Record<string, unknown>;
    merged.action = 'closed';
    Object.assign(merged.pull_request as Record<string, unknown>, { merged: true });
    await ingestor.handle(ghInput(JSON.stringify(merged), 'delivery-TIE-MERGED'));

    const delayedReopen = structuredClone(opened) as Record<string, unknown>;
    delayedReopen.action = 'reopened';
    await ingestor.handle(ghInput(JSON.stringify(delayedReopen), 'delivery-TIE-REOPEN'));

    expect(
      await db
        .selectFrom('change_requests')
        .select('state')
        .where('repository_id', '=', REPO)
        .where('native_id', '=', '5102')
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'merged' });
  });

  it('provider event dedupe is committed atomically with domain persistence and jobs', async () => {
    const adapters = buildAdapters();
    const github = adapters.github!;
    let failNormalization = true;
    const atomicIngestor = new WebhookIngestor({
      db,
      adapters: {
        github: {
          ...github,
          normalize: (raw) => {
            if (failNormalization) throw new Error('synthetic normalization failure');
            return github.normalize(raw);
          },
        },
      },
      resolveContext: createDbContextResolver(db),
      resolveSecret: async () => SECRET,
    });
    const body = githubBody('opened', 'atomic-head');
    const input = ghInput(body, 'delivery-ATOMIC-RETRY');

    await expect(atomicIngestor.handle(input)).rejects.toThrow('synthetic normalization failure');
    expect(
      await db
        .selectFrom('provider_events')
        .select('id')
        .where('dedupe_key', '=', `github:${HOST}:delivery-ATOMIC-RETRY`)
        .executeTakeFirst(),
    ).toBeUndefined();

    failNormalization = false;
    expect((await atomicIngestor.handle(input)).status).toBe('accepted');
  });

  it('已存在 revision 的重复 webhook 不再创建新的 review Job', async () => {
    const before = await db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('type', '=', 'review_revision')
      .executeTakeFirstOrThrow();
    const result = await ingestor.handle(
      ghInput(githubBody('synchronize', 'ffff', 'eeee'), 'delivery-REPEAT-HEAD'),
    );
    expect(result.status).toBe('accepted');
    expect(result.status === 'accepted' ? result.scheduledJobIds : []).toHaveLength(0);
    const after = await db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('type', '=', 'review_revision')
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
  });

  it('仓库解析同时要求 provider host 与 tenant 所有权匹配', async () => {
    const otherTenant = uuidv7();
    const otherRepo = uuidv7();
    await db
      .insertInto('tenants')
      .values({
        id: otherTenant,
        name: `other-${otherTenant}`,
        region: null,
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('repositories')
      .values({
        id: otherRepo,
        tenant_id: otherTenant,
        provider_host_id: HOST,
        installation_id: INSTALL,
        native_id: '901',
        namespace: 'other',
        name: 'foreign',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 999 },
      pull_request: {
        id: 6001,
        number: 9,
        draft: false,
        head: { sha: 'foreign-head', ref: 'feature/y', repo: { id: 901, private: false } },
        base: { sha: 'foreign-base', ref: 'main', repo: { id: 901 } },
      },
      repository: {
        id: 901,
        name: 'foreign',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'other' },
      },
      sender: { id: 7, login: 'alice', type: 'User' },
    });
    const result = await ingestor.handle(ghInput(body, 'delivery-FOREIGN-REPO'));
    expect(result.status).toBe('accepted');
    const event = await db
      .selectFrom('domain_events')
      .select(['repository_id', 'change_request_id'])
      .where('provider_event_id', '=', result.status === 'accepted' ? result.providerEventId : '')
      .executeTakeFirstOrThrow();
    expect(event).toEqual({ repository_id: null, change_request_id: null });
    expect(result.status === 'accepted' ? result.scheduledJobIds : []).toHaveLength(0);
  });

  it('installation.changed(created)→ 入队 sync_installation', async () => {
    const body = installationBody('created');
    const result = await ingestor.handle(
      ghInput(body, 'delivery-INST', sign(body), 'installation'),
    );
    expect(result.status).toBe('accepted');

    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'sync_installation')
      .executeTakeFirst();
    expect(job).toBeTruthy();
    expect((job!.payload as { installationNativeId?: string }).installationNativeId).toBe('999');
    expect((job!.payload as { internalInstallationId?: string }).internalInstallationId).toBe(
      INSTALL,
    );
  });

  it('workflow_run 失败 → 入队 pipeline_analyze(§29;按 headSha 反查 CR)', async () => {
    const body = workflowRunBody('failure', 'aaaa');
    const result = await ingestor.handle(
      ghInput(body, 'delivery-CI-FAIL', sign(body), 'workflow_run'),
    );
    expect(result.status).toBe('accepted');
    const cr = await db
      .selectFrom('change_requests')
      .selectAll()
      .where('repository_id', '=', REPO)
      .executeTakeFirstOrThrow();
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'pipeline_analyze')
      .executeTakeFirst();
    expect(job).toBeTruthy();
    const payload = job!.payload as { changeRequestId?: string; headSha?: string };
    expect(payload.changeRequestId).toBe(cr.id);
    expect(payload.headSha).toBe('aaaa');
  });

  it('workflow_run 成功 → 不入队 pipeline_analyze', async () => {
    const before = await db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('type', '=', 'pipeline_analyze')
      .executeTakeFirstOrThrow();
    const body = workflowRunBody('success', 'aaaa');
    const result = await ingestor.handle(
      ghInput(body, 'delivery-CI-OK', sign(body), 'workflow_run'),
    );
    expect(result.status).toBe('accepted');
    const after = await db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('type', '=', 'pipeline_analyze')
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
  });

  it('同一 SHA 属于多个开放 CR 时分别调度,不任意归到其中一个', async () => {
    const crId = uuidv7();
    const revisionId = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: crId,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: 'shared-sha-cr',
        number: 53,
        kind: 'pull-request',
        source_branch: 'shared',
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
        id: revisionId,
        tenant_id: TENANT,
        change_request_id: crId,
        base_sha: 'base-shared',
        head_sha: 'aaaa',
        merge_base_sha: null,
        source_branch: 'shared',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    try {
      const body = workflowRunBody('failure', 'aaaa');
      const result = await ingestor.handle(
        ghInput(body, 'delivery-CI-SHARED', sign(body), 'workflow_run'),
      );
      expect(result.status).toBe('accepted');
      expect(result.status === 'accepted' ? result.scheduledJobIds : []).toHaveLength(2);
      const jobs = await db
        .selectFrom('jobs')
        .select('payload')
        .where('type', '=', 'pipeline_analyze')
        .where('dedupe_key', 'in', [`pipeline:${crId}:aaaa`])
        .execute();
      expect(
        jobs.map((job) => (job.payload as { changeRequestId: string }).changeRequestId),
      ).toEqual([crId]);
    } finally {
      await db.deleteFrom('jobs').where('dedupe_key', '=', `pipeline:${crId}:aaaa`).execute();
      await db.deleteFrom('revisions').where('id', '=', revisionId).execute();
      await db.deleteFrom('change_requests').where('id', '=', crId).execute();
    }
  });

  it('issues.opened → 入队 issue_enrich(§30,mode enrich)', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 999 },
      issue: { id: 6001, number: 15, title: 'Bug', body: 'repro' },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      sender: { id: 7, login: 'alice', type: 'User' },
    });
    const result = await ingestor.handle(ghInput(body, 'delivery-ISSUE', sign(body), 'issues'));
    expect(result.status).toBe('accepted');
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'issue_enrich')
      .executeTakeFirst();
    expect(job).toBeTruthy();
    const payload = job!.payload as { issueNumber?: number; mode?: string; issueNativeId?: string };
    expect(payload.issueNumber).toBe(15);
    expect(payload.mode).toBe('enrich');
    expect(payload.issueNativeId).toBe('6001');
  });

  it('bot 开的 issue → 不入队 issue_enrich(自己开的 follow-up issue 不该再被自己分诊)', async () => {
    const before = await db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('type', '=', 'issue_enrich')
      .executeTakeFirstOrThrow();
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 999 },
      issue: { id: 6002, number: 16, title: '#236 合并后的自动跟进', body: 'follow-up' },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      sender: { id: 305734977, login: 'winnowl[bot]', type: 'Bot' },
    });
    const result = await ingestor.handle(ghInput(body, 'delivery-ISSUE-BOT', sign(body), 'issues'));
    expect(result.status).toBe('accepted'); // recorded, just not triaged
    const after = await db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('type', '=', 'issue_enrich')
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
  });

  it('重复投递(同 delivery id)→ duplicate,不重复落库', async () => {
    const body = githubBody('opened');
    const result = await ingestor.handle(ghInput(body, 'delivery-A'));
    expect(result.status).toBe('duplicate');
  });

  it('review_request_removed → updated 事件全量刷新 reviewers(清空也覆盖,§P4)', async () => {
    const result = await ingestor.handle(
      ghInput(githubBody('review_request_removed'), 'delivery-RR'),
    );
    expect(result.status).toBe('accepted');
    const cr = await db
      .selectFrom('change_requests')
      .selectAll()
      .where('repository_id', '=', REPO)
      .executeTakeFirstOrThrow();
    expect(cr.reviewers).toEqual([]);
  });

  it('签名错误 → unauthorized,但留存审计行(signature_valid=false),不产生 domain event', async () => {
    const body = githubBody('opened');
    const result = await ingestor.handle(ghInput(body, 'delivery-B', 'sha256=deadbeef'));
    expect(result.status).toBe('unauthorized');
    // Rejected deliveries use a `rejected:` key so a valid redelivery is not deduped away.
    const row = await db
      .selectFrom('provider_events')
      .selectAll()
      .where('dedupe_key', '=', 'rejected:github:' + HOST + ':delivery-B')
      .executeTakeFirst();
    expect(row?.signature_valid).toBe(false);
    expect(
      await db
        .selectFrom('provider_events')
        .select('id')
        .where('dedupe_key', '=', 'github:' + HOST + ':delivery-B')
        .executeTakeFirst(),
    ).toBeUndefined();
    const de = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('provider_event_id', '=', row!.id)
      .executeTakeFirst();
    expect(de).toBeUndefined();

    await expect(
      ingestor.handle(ghInput(body, 'delivery-B')),
    ).resolves.toMatchObject({ status: 'accepted' });
  });

  // Out-of-order delivery: GitHub can send opened after comment/metadata events. Author must be set from the
  // first event (coalesce); draft follows the newest event. Uses its own PR #99 to avoid disturbing #42.
  const ORDERING_CR = 99;
  const pullBody = (
    action: string,
    over: { updatedAt: string; draft?: boolean; user?: { id: number; login: string; type: string } | null },
  ): string =>
    JSON.stringify({
      action,
      installation: { id: 999 },
      pull_request: {
        id: 5099,
        number: ORDERING_CR,
        draft: over.draft ?? false,
        updated_at: over.updatedAt,
        user: over.user ?? { id: 4242, login: 'octocat', type: 'User' },
        head: { sha: 'aaaa', ref: 'feature/x', repo: { id: 900, private: false } },
        base: { sha: 'bbbb', ref: 'main', repo: { id: 900 } },
      },
      repository: { id: 900, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
      sender: { id: 7, login: 'alice', type: 'User' },
    });

  const crRow = async () =>
    db
      .selectFrom('change_requests')
      .select(['author', 'author_provider_id', 'author_is_bot', 'draft', 'state'])
      .where('repository_id', '=', REPO)
      .where('number', '=', ORDERING_CR)
      .executeTakeFirstOrThrow();

  it('metadata 事件先到(opened 迟到)→ 作者也写进去了,迟到的 opened 不会把它抹掉', async () => {
    const labeled = pullBody('labeled', { updatedAt: '2026-10-01T10:00:05Z' });
    await expect(
      ingestor.handle(ghInput(labeled, 'delivery-late-opened-labeled')),
    ).resolves.toMatchObject({ status: 'accepted' });
    // Known human -> false, not NULL, so the gate does not fall back to the `[bot]` suffix heuristic.
    expect(await crRow()).toMatchObject({
      author: 'octocat',
      author_provider_id: '4242',
      author_is_bot: false,
    });

    // A late, older opened must not clear the author or roll back state.
    const opened = pullBody('opened', { updatedAt: '2026-10-01T10:00:00Z' });
    await ingestor.handle(ghInput(opened, 'delivery-late-opened-opened'));
    expect(await crRow()).toMatchObject({
      author: 'octocat',
      author_provider_id: '4242',
      state: 'open',
    });
  });

  it('draft 取"带它的最新事件"(metadata 事件也能刷新)', async () => {
    await ingestor.handle(
      ghInput(pullBody('converted_to_draft', { updatedAt: '2026-10-01T11:00:00Z', draft: true }), 'delivery-draft-in'),
    );
    expect(await crRow()).toMatchObject({ draft: true, author: 'octocat' });
    // A newer labeled event with draft=false refreshes draft; author unchanged.
    const labeled = pullBody('labeled', { updatedAt: '2026-10-01T11:30:00Z', draft: false });
    await ingestor.handle(ghInput(labeled, 'delivery-draft-labeled'));
    expect(await crRow()).toMatchObject({ draft: false, author: 'octocat' });
  });

  it('同一秒内 closed → reopened:重开赢(否则 PR 永远停在 closed)', async () => {
    const at = '2026-10-01T12:00:00Z';
    await ingestor.handle(
      ghInput(JSON.stringify({ ...JSON.parse(pullBody('closed', { updatedAt: at })), action: 'closed' }), 'delivery-tie-closed'),
    );
    expect((await crRow()).state).toBe('closed');
    await ingestor.handle(ghInput(pullBody('reopened', { updatedAt: at }), 'delivery-tie-reopened'));
    expect((await crRow()).state).toBe('open');
  });

  it('同一秒内 merged 仍是终态:重开盖不过它', async () => {
    const at = '2026-10-01T13:00:00Z';
    const merged = JSON.parse(pullBody('closed', { updatedAt: at })) as Record<string, unknown>;
    (merged['pull_request'] as Record<string, unknown>)['merged'] = true;
    await ingestor.handle(ghInput(JSON.stringify(merged), 'delivery-tie-merged'));
    expect((await crRow()).state).toBe('merged');
    await ingestor.handle(ghInput(pullBody('reopened', { updatedAt: at }), 'delivery-tie-reopened-2'));
    expect((await crRow()).state).toBe('merged');
  });

  it('未知 installation → unresolved', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 12345 },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      pull_request: {
        id: 1,
        number: 1,
        head: { sha: 'a', ref: 'f' },
        base: { sha: 'b', ref: 'main' },
      },
      sender: { id: 1, login: 'x', type: 'User' },
    });
    const result = await ingestor.handle(ghInput(body, 'delivery-C'));
    expect(result.status).toBe('unresolved');
  });

  it('comment.created(含 @mention)→ 入队 conversation_turn(§26)', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 999 },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      issue: { id: 5001, number: 42, pull_request: { url: 'x' } },
      comment: {
        id: 7001,
        body: '@winnowl review this',
        user: { id: 7, login: 'alice', type: 'User' },
      },
    });
    const result = await ingestor.handle(
      ghInput(body, 'delivery-COMMENT', sign(body), 'issue_comment'),
    );
    expect(result.status).toBe('accepted');
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'conversation_turn')
      .executeTakeFirst();
    expect(job).toBeTruthy();
    const payload = job!.payload as {
      body?: string;
      target?: { nativeId?: string };
      installationId?: string;
    };
    expect(payload.body).toContain('@winnowl');
    expect(payload.target?.nativeId).toBe('5001');
    expect(payload.installationId).toBe(INSTALL);
  });

  it('a command on a pull request not registered yet carries its number for the runner, with more retries', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 999 },
      repository: { id: 900, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
      issue: { id: 5777, number: 777, pull_request: { url: 'x' } },
      comment: { id: 7777, body: '@winnowl review', user: { id: 77, login: 'early-bird', type: 'User' } },
    });
    expect((await ingestor.handle(ghInput(body, 'delivery-EARLY', sign(body), 'issue_comment'))).status).toBe('accepted');
    const job = (await db.selectFrom('jobs').selectAll().where('type', '=', 'conversation_turn').execute()).find(
      (j) => (j.payload as { actorLogin?: string }).actorLogin === 'early-bird',
    )!;
    const payload = job.payload as { changeRequestId?: string; pendingChange?: { number: number; kind: string } };
    expect(payload.changeRequestId).toBeUndefined();
    expect(payload.pendingChange).toEqual({ number: 777, kind: 'pull-request' });
    expect(job.max_attempts).toBe(6);
  });

  it('a reply in an inline review thread is queued without a mention; a plain PR comment is not', async () => {
    const repository = { id: 900, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } };
    const threadReply = JSON.stringify({
      action: 'created',
      installation: { id: 999 },
      repository,
      pull_request: { id: 5001, number: 42 },
      comment: { id: 7101, in_reply_to_id: 7100, path: 'src/a.ts', body: 'This cannot be empty: the form requires one sample.', user: { id: 8, login: 'thread-replier', type: 'User' } },
    });
    await ingestor.handle(ghInput(threadReply, 'delivery-THREAD-REPLY', sign(threadReply), 'pull_request_review_comment'));
    const queued = (await db.selectFrom('jobs').select('payload').where('type', '=', 'conversation_turn').execute())
      .map((j) => j.payload as { actorLogin?: string; target?: { kind?: string; nativeId?: string } })
      .filter((p) => p.actorLogin === 'thread-replier');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.target).toEqual({ kind: 'review-thread', nativeId: '7100' });

    const plain = JSON.stringify({
      action: 'created',
      installation: { id: 999 },
      repository,
      issue: { id: 5001, number: 42, pull_request: { url: 'x' } },
      comment: { id: 7102, body: 'LGTM', user: { id: 9, login: 'plain-commenter', type: 'User' } },
    });
    await ingestor.handle(ghInput(plain, 'delivery-PLAIN', sign(plain), 'issue_comment'));
    expect(await conversationPayloadOf(db, 'plain-commenter')).toBeUndefined();
  });

  it('issue_comment 的 issue.id ≠ pull_request.id → 不裂行:按 (repo, number) 解析既有 CR,不新建(2026-07-18 live 缺陷回归)', async () => {
    // On GitHub a PR's issue.id differs from its pull_request.id.
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 999 },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      issue: { id: 990101, number: 42, pull_request: { url: 'x' } },
      comment: { id: 7002, body: '@winnowl review', user: { id: 7, login: 'alice', type: 'User' } },
    });
    const result = await ingestor.handle(
      ghInput(body, 'delivery-COMMENT-SPLIT', sign(body), 'issue_comment'),
    );
    expect(result.status).toBe('accepted');
    const crs = await db
      .selectFrom('change_requests')
      .selectAll()
      .where('repository_id', '=', REPO)
      .where('number', '=', 42)
      .execute();
    expect(crs).toHaveLength(1);
    expect(crs[0]!.native_id).toBe('5001');
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'conversation_turn')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    expect((job!.payload as { changeRequestId?: string }).changeRequestId).toBe(crs[0]!.id);
  });

  it('draft:ready 清掉标记并对当前 head 补一次 review;转回 draft 只刷标记(flutter_server_box#1575)', async () => {
    const pr = (action: string, draft: boolean, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        action,
        installation: { id: 999 },
        repository: { id: 900, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
        pull_request: { id: 7501, number: 75, draft, head: { sha: 'd1', ref: 'feat/d' }, base: { sha: 'b1', ref: 'main' } },
        sender: { id: 7, login: 'alice', type: 'User' },
        ...extra,
      });
    const draftOf = async () =>
      (await db.selectFrom('change_requests').select('draft').where('native_id', '=', '7501').executeTakeFirstOrThrow()).draft;
    const reviewJobs = async () =>
      (await db.selectFrom('jobs').select('payload').where('type', '=', 'review_revision').execute()).filter(
        (j) => (j.payload as { headSha?: string }).headSha === 'd1',
      );

    for (const [action, draft, id] of [['opened', true, 'D-1']] as const) {
      const body = pr(action, draft);
      await ingestor.handle(ghInput(body, `delivery-${id}`, sign(body)));
    }
    expect(await draftOf()).toBe(true);
    const afterOpen = (await reviewJobs()).length;
    // Finish the opened job, otherwise dedupe would absorb the ready-for-review job.
    await db.updateTable('jobs').set({ status: 'completed' }).where('type', '=', 'review_revision').execute();

    const ready = pr('ready_for_review', false);
    await ingestor.handle(ghInput(ready, 'delivery-D-2', sign(ready)));
    expect(await draftOf()).toBe(false);
    expect((await reviewJobs()).length).toBe(afterOpen + 1);

    const back = pr('converted_to_draft', true);
    await ingestor.handle(ghInput(back, 'delivery-D-3', sign(back)));
    expect(await draftOf()).toBe(true);
    expect((await reviewJobs()).length).toBe(afterOpen + 1);
  });

  it('状态评论的触发复选框被人勾上 → 入队带 review-checkbox 命令的 conversation_turn;其它编辑不触发', async () => {
    const box = '- [ ] <!-- winnowl:trigger=review --> Review this pull request now';
    const edit = (id: string, opts: { author: string; sender: { login: string; type: string }; from: string; to: string }) =>
      JSON.stringify({
        action: 'edited',
        installation: { id: 999 },
        repository: { id: 900, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
        issue: { id: 5001, number: 42, pull_request: { url: 'x' } },
        comment: { id: Number(id), body: opts.to, user: { id: 1, login: opts.author, type: 'Bot' } },
        changes: { body: { from: opts.from } },
        sender: { id: 7, ...opts.sender },
      });
    const commandJobs = async () =>
      (await db.selectFrom('jobs').selectAll().where('type', '=', 'conversation_turn').execute()).filter(
        (j) => (j.payload as { command?: unknown }).command !== undefined,
      );
    const ticked = box.replace('- [ ]', '- [x]');
    const cases = [
      // Someone else's comment copying the marker.
      { id: '8101', author: 'mallory', sender: { login: 'alice', type: 'User' }, from: box, to: ticked },
      // A bot editing its own comment.
      { id: '8102', author: 'winnowl[bot]', sender: { login: 'winnowl[bot]', type: 'Bot' }, from: box, to: ticked },
      // An edit that does not change the checkbox.
      { id: '8103', author: 'winnowl[bot]', sender: { login: 'alice', type: 'User' }, from: box, to: `${box}\nmore` },
    ];
    for (const c of cases) {
      const body = edit(c.id, c);
      await ingestor.handle(ghInput(body, `delivery-EDIT-${c.id}`, sign(body), 'issue_comment'));
    }
    expect(await commandJobs()).toHaveLength(0);

    const body = edit('8104', { author: 'winnowl[bot]', sender: { login: 'alice', type: 'User' }, from: box, to: ticked });
    const result = await ingestor.handle(ghInput(body, 'delivery-EDIT-8104', sign(body), 'issue_comment'));
    expect(result.status).toBe('accepted');
    const jobs = await commandJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({
      actorLogin: 'alice',
      body: '',
      command: { kind: 'review-checkbox', commentNativeId: '8104' },
      target: { kind: 'change-request', nativeId: '5001' },
    });
    expect((jobs[0]!.payload as { changeRequestId?: string }).changeRequestId).toBeTruthy();
  });

  it('review 正文里「修复这些问题」的复选框被人勾上 → 入队带 fix-checkbox 命令的 conversation_turn', async () => {
    const box = '- [ ] <!-- winnowl:trigger=fix --> 🪄 Fix these findings';
    const body = JSON.stringify({
      action: 'edited',
      installation: { id: 999 },
      repository: { id: 900, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
      pull_request: { id: 4201, number: 42, head: { sha: 'h', ref: 'f' }, base: { sha: 'b', ref: 'main' } },
      review: { id: 9901, body: box.replace('- [ ]', '- [x]'), user: { id: 1, login: 'winnowl[bot]', type: 'Bot' } },
      changes: { body: { from: box } },
      sender: { id: 7, login: 'alice', type: 'User' },
    });
    const result = await ingestor.handle(ghInput(body, 'delivery-REVIEW-EDIT', sign(body), 'pull_request_review'));
    expect(result.status).toBe('accepted');
    const jobs = (await db.selectFrom('jobs').selectAll().where('type', '=', 'conversation_turn').execute()).filter(
      (j) => (j.payload as { command?: { kind?: string } }).command?.kind === 'fix-checkbox',
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ actorLogin: 'alice', command: { commentNativeId: '9901' } });
  });

  it('stacked PR:base 指向本仓另一个 open PR 的分支 → 记下父 CR;原生 stack 字段一并落库(§26.7)', async () => {
    // Root of the stack (base=main).
    const parentBody = JSON.stringify({
      action: 'opened',
      installation: { id: 999 },
      pull_request: {
        id: 6001,
        number: 60,
        draft: false,
        head: { sha: 's1', ref: 'feat/layer-1', repo: { id: 900 } },
        base: { sha: 'b1', ref: 'main', repo: { id: 900 } },
      },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      sender: { id: 7, login: 'alice', type: 'User' },
    });
    expect(
      (await ingestor.handle(ghInput(parentBody, 'delivery-STACK-PARENT', sign(parentBody))))
        .status,
    ).toBe('accepted');

    // Upper PR on feat/layer-1 with GitHub's native stack fields.
    const childBody = JSON.stringify({
      action: 'opened',
      installation: { id: 999 },
      pull_request: {
        id: 6002,
        number: 61,
        draft: false,
        head: { sha: 's2', ref: 'feat/layer-2', repo: { id: 900 } },
        base: { sha: 's1', ref: 'feat/layer-1', repo: { id: 900 } },
        stack: { id: 9, size: 2, position: 2, base: { ref: 'main', sha: 'b1' } },
      },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      sender: { id: 7, login: 'alice', type: 'User' },
    });
    expect(
      (await ingestor.handle(ghInput(childBody, 'delivery-STACK-CHILD', sign(childBody)))).status,
    ).toBe('accepted');

    const parent = await db
      .selectFrom('change_requests')
      .selectAll()
      .where('native_id', '=', '6001')
      .executeTakeFirstOrThrow();
    const child = await db
      .selectFrom('change_requests')
      .selectAll()
      .where('native_id', '=', '6002')
      .executeTakeFirstOrThrow();
    expect(child.stacked_on_change_request_id).toBe(parent.id); // from branch topology
    expect(child.stack_base_ref).toBe('main'); // from the native field
    expect(child.stack_position).toBe(2);
    expect(child.stack_size).toBe(2);
    expect(parent.stacked_on_change_request_id).toBeNull();
  });

  it('fork PR 的源分支与本仓分支同名(fork 的 main)→ 不当作 stack 父 PR,本仓 push 也不归到它', async () => {
    const prBody = (id: number, number: number, head: object, base: object) =>
      JSON.stringify({
        action: 'opened',
        installation: { id: 999 },
        pull_request: { id, number, draft: false, head, base },
        repository: {
          id: 900,
          name: 'app',
          default_branch: 'main',
          clone_url: 'x',
          owner: { login: 'acme' },
        },
        sender: { id: 7, login: 'alice', type: 'User' },
      });
    const forkBody = prBody(
      6101,
      70,
      { sha: 'f1', ref: 'main', repo: { id: 901 } },
      { sha: 'b1', ref: 'main', repo: { id: 900 } },
    );
    await ingestor.handle(ghInput(forkBody, 'delivery-FORK-MAIN', sign(forkBody)));
    const ownBody = prBody(
      6102,
      71,
      { sha: 'o1', ref: 'feat/own', repo: { id: 900 } },
      { sha: 'b1', ref: 'main', repo: { id: 900 } },
    );
    await ingestor.handle(ghInput(ownBody, 'delivery-OWN-ON-MAIN', sign(ownBody)));

    const rows = await db
      .selectFrom('change_requests')
      .select(['native_id', 'source_is_fork', 'stacked_on_change_request_id'])
      .where('native_id', 'in', ['6101', '6102'])
      .orderBy('native_id')
      .execute();
    expect(rows).toEqual([
      { native_id: '6101', source_is_fork: true, stacked_on_change_request_id: null },
      { native_id: '6102', source_is_fork: false, stacked_on_change_request_id: null },
    ]);

    // A push to this repo's main is not a new head of a fork PR from `main`.
    await ingestor.handle(
      ghInput(pushBody('refs/heads/main', 'upstream-main-head'), 'delivery-PUSH-MAIN', undefined, 'push'),
    );
    expect(
      await db
        .selectFrom('revisions')
        .select('id')
        .where('head_sha', '=', 'upstream-main-head')
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('bot 自己发的评论 → 不入队 conversation_turn(自触发守卫;2026-07-31 live 缺陷回归)', async () => {
    // Our inline comments end with the `@winnowl fix` hint, and GitHub delivers our own comment events back.
    const before = await db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('type', '=', 'conversation_turn')
      .executeTakeFirstOrThrow();
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 999 },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      pull_request: { id: 5001, number: 42, draft: false },
      comment: {
        id: 8200,
        body: '🔀 **Concurrency** | 🟠 **High**\n\n…\n\n让 bot 修复:评论 `@winnowl fix`。',
        user: { id: 305734977, login: 'winnowl[bot]', type: 'Bot' },
        path: 'api/handler.go',
        line: 53,
      },
      sender: { id: 305734977, login: 'winnowl[bot]', type: 'Bot' },
    });
    const result = await ingestor.handle(
      ghInput(body, 'delivery-SELF-COMMENT', sign(body), 'pull_request_review_comment'),
    );
    expect(result.status).toBe('accepted');
    expect(result.status === 'accepted' && result.scheduledJobIds).toEqual([]);
    const after = await db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('type', '=', 'conversation_turn')
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
    const de = await db
      .selectFrom('domain_events')
      .selectAll()
      .where('type', '=', 'comment.created')
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    expect((de.payload as { actor?: { login?: string } }).actor?.login).toBe('winnowl[bot]');
  });

  it('第三方 bot 的评论 → 仍入队,但标记 actorIsBot(runner 侧只放行只读意图)', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 999 },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      issue: { id: 5001, number: 42, pull_request: { url: 'x' } },
      comment: {
        id: 7003,
        body: '@winnowl fix',
        user: { id: 88, login: 'coderabbitai[bot]', type: 'Bot' },
      },
    });
    const result = await ingestor.handle(
      ghInput(body, 'delivery-OTHER-BOT', sign(body), 'issue_comment'),
    );
    expect(result.status).toBe('accepted');
    const payload = await conversationPayloadOf(db, 'coderabbitai[bot]');
    expect(payload?.actorIsBot).toBe(true);
  });

  it('人类评论 → 不带 actorIsBot(不误伤正常命令)', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 999 },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      issue: { id: 5001, number: 42, pull_request: { url: 'x' } },
      comment: { id: 7004, body: '@winnowl fix', user: { id: 7, login: 'alice', type: 'User' } },
    });
    const result = await ingestor.handle(
      ghInput(body, 'delivery-HUMAN-FIX', sign(body), 'issue_comment'),
    );
    expect(result.status).toBe('accepted');
    const payload = await conversationPayloadOf(db, 'alice');
    expect(payload).toBeTruthy();
    expect(payload?.actorIsBot).toBeUndefined();
  });

  it('push 到开放 CR 源分支 → 入队 review_revision(新 head;与 synchronize 同 head 去重,§9)', async () => {
    await ingestor.handle(ghInput(githubBody('opened'), 'delivery-PUSH-OPEN'));
    const currentHead = await db
      .selectFrom('revisions as revision')
      .innerJoin('change_requests as cr', 'cr.id', 'revision.change_request_id')
      .select('revision.head_sha')
      .where('cr.repository_id', '=', REPO)
      .where('cr.number', '=', 42)
      .orderBy('revision.created_at', 'desc')
      .executeTakeFirstOrThrow();
    const result = await ingestor.handle(
      ghInput(
        pushBody('refs/heads/feature/x', 'pushhead1', currentHead.head_sha),
        'delivery-PUSH',
        undefined,
        'push',
      ),
    );
    expect(result.status).toBe('accepted');
    const jobs = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'review_revision')
      .execute();
    expect(jobs.some((j) => (j.payload as { headSha?: string }).headSha === 'pushhead1')).toBe(
      true,
    );
    const rev = await db
      .selectFrom('revisions')
      .selectAll()
      .where('head_sha', '=', 'pushhead1')
      .executeTakeFirst();
    expect(rev).toBeTruthy();
  });

  it('延迟 push 不会用旧 head 反向 supersede 当前 review', async () => {
    await ingestor.handle(ghInput(githubBody('opened', 'push-old'), 'delivery-PUSH-ORDER-OPEN'));
    await ingestor.handle(
      ghInput(
        pushBody('refs/heads/feature/x', 'push-new', 'push-old'),
        'delivery-PUSH-ORDER-NEW',
        undefined,
        'push',
      ),
    );
    const delayed = await ingestor.handle(
      ghInput(
        pushBody('refs/heads/feature/x', 'push-stale', 'ancestor'),
        'delivery-PUSH-ORDER-STALE',
        undefined,
        'push',
      ),
    );
    expect(delayed.status).toBe('accepted');
    expect(delayed.status === 'accepted' ? delayed.scheduledJobIds : []).toHaveLength(0);
    expect(
      await db
        .selectFrom('revisions')
        .select('id')
        .where('head_sha', '=', 'push-stale')
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('push 到无开放 CR 的分支 → 不入队 review', async () => {
    const result = await ingestor.handle(
      ghInput(
        pushBody('refs/heads/no-cr-branch', 'orphanhead'),
        'delivery-PUSH-ORPHAN',
        undefined,
        'push',
      ),
    );
    expect(result.status).toBe('accepted');
    const jobs = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'review_revision')
      .execute();
    expect(jobs.some((j) => (j.payload as { headSha?: string }).headSha === 'orphanhead')).toBe(
      false,
    );
  });

  it('pull_request_review_comment(行内 @mention)→ conversation_turn(target=review-thread + anchorPath,§26.3)', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 999 },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      pull_request: { id: 5001, number: 42, draft: false },
      comment: {
        id: 8123,
        body: '@winnowl explain this',
        user: { id: 7, login: 'alice', type: 'User' },
        path: 'src/math.ts',
        line: 6,
      },
      sender: { id: 7, login: 'alice', type: 'User' },
    });
    const result = await ingestor.handle(
      ghInput(body, 'delivery-RVW-COMMENT', sign(body), 'pull_request_review_comment'),
    );
    expect(result.status).toBe('accepted');
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'conversation_turn')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    const payload = job!.payload as {
      target?: { kind?: string; nativeId?: string };
      anchorPath?: string;
      changeRequestId?: string;
    };
    expect(payload.target?.kind).toBe('review-thread');
    expect(payload.target?.nativeId).toBe('8123'); // thread = comment id
    expect(payload.anchorPath).toBe('src/math.ts');
    expect(payload.changeRequestId).toBeTruthy();
  });

  it('change-request.merged → 入队 post_merge_action(§34)', async () => {
    const body = JSON.stringify({
      action: 'closed',
      installation: { id: 999 },
      repository: {
        id: 900,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      pull_request: {
        id: 5001,
        number: 42,
        merged: true,
        merge_commit_sha: 'mmmm',
        head: { sha: 'aaaa', ref: 'feature/x' },
        base: { sha: 'bbbb', ref: 'main' },
      },
      sender: { id: 7, login: 'alice', type: 'User' },
    });
    const result = await ingestor.handle(ghInput(body, 'delivery-MERGED'));
    expect(result.status).toBe('accepted');
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'post_merge_action')
      .executeTakeFirst();
    expect(job).toBeTruthy();
    expect((job!.payload as { changeRequestId?: string }).changeRequestId).toBeTruthy();
  });

  it('通过 HTTP 端点(202 / 200 幂等)', async () => {
    const app = await buildWebhookIngress({ ingestor, quiet: true });
    await app.ready();
    const body = githubBody('opened');
    const headers = {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-H',
      'x-hub-signature-256': sign(body),
      'content-type': 'application/json',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers,
      payload: body,
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers,
      payload: body,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'duplicate' });

    process.env.METRICS_TOKEN = 'metrics-secret';
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    const metrics = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-secret' },
    });
    delete process.env.METRICS_TOKEN;
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('webhook_received_total');
    expect(metrics.body).toContain('webhook_processed_total');

    await app.close();
  });
});
