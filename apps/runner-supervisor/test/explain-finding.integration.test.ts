import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { PromptBundle } from '@reviewbot/prompts';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend, SourceControlProvider } from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createExplainFindingHandler } from '../src/explain-finding.js';
import { Supervisor } from '../src/supervisor.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();
const FINDING_HIGH = uuidv7();
const FINDING_LOW = uuidv7();

const noopSandbox = {
  create: async () => ({ id: 's', containerId: 'c' }),
  exec: async () => {
    throw new Error('x');
  },
  putFile: async () => undefined,
  getArtifact: async () => ({ path: '', content: '', bytes: 0 }),
  destroy: async () => undefined,
} as unknown as SandboxBackend;

const bundle: PromptBundle = {
  role: 'explainer',
  system: 'sys',
  task: 'task',
  version: 1,
  digest: 'd',
};

interface Posted {
  markdown: string;
  key: string;
  target: 'top-level' | 'thread';
  nativeId?: string;
}

function provider(posted: Posted[]): SourceControlProvider {
  return {
    discussions: {
      createTopLevelComment: async (
        _target: unknown,
        body: { markdown: string },
        idem: { key: string },
      ) => {
        posted.push({ markdown: body.markdown, key: idem.key, target: 'top-level' });
        return { nativeId: 'c1' };
      },
      reply: async (
        thread: { nativeId: string },
        body: { markdown: string },
        idem: { key: string },
      ) => {
        posted.push({
          markdown: body.markdown,
          key: idem.key,
          target: 'thread',
          nativeId: thread.nativeId,
        });
        return { nativeId: 'r1', threadNativeId: thread.nativeId };
      },
    },
  } as unknown as SourceControlProvider;
}

async function seedFinding(
  db: Db,
  id: string,
  claim: string,
  severity: string,
  path: string,
  opts: { revisionId?: string; confirmation?: string } = {},
): Promise<void> {
  await db
    .insertInto('findings')
    .values({
      id,
      tenant_id: TENANT,
      repository_id: REPO,
      semantic_fingerprint: `fp-${id}`,
      category: 'correctness',
      canonical_claim: claim,
      lifecycle: 'published',
      first_seen_at: new Date(),
      last_seen_at: new Date(),
    })
    .execute();
  await db
    .insertInto('finding_occurrences')
    .values({
      id: uuidv7(),
      tenant_id: TENANT,
      finding_id: id,
      review_run_id: null,
      revision_id: opts.revisionId ?? REV,
      state: 'inline',
      severity,
      change_relation: 'introduced',
      confirmation: opts.confirmation ?? 'independently-verified',
      anchor: JSON.stringify({ path, line: 7 }) as unknown as Record<string, unknown>,
      evidence: JSON.stringify([]) as unknown as unknown[],
      created_at: new Date(),
    })
    .execute();
}

describe('explain_finding handler', () => {
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
    await seedFinding(db, FINDING_HIGH, 'mul returns a+b instead of a*b', 'high', 'src/math.ts');
    await seedFinding(db, FINDING_LOW, 'style nit in helper', 'low', 'src/util.ts');
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  });

  afterAll(async () => {
    await stop?.();
  });

  function supervisor(posted: Posted[], explanation: string): Supervisor {
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('submit_explanation', { explanation }))]);
    const handler = createExplainFindingHandler({
      bundle,
      modelSource: () => ({ model: faux.model, streamFn: faux.streamFn }),
      buildProvider: async () => provider(posted),
    });
    return new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { explain_finding: handler },
    });
  }

  it('无锚点 → 挑最高严重度 Finding 并发布解释', async () => {
    const posted: Posted[] = [];
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'explain_finding',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR,
        targetKind: 'change-request',
        targetNativeId: '42',
      },
      dedupeKey: 'ef-1',
    });
    await supervisor(posted, '## 解释\nmul 实现为加法。').runOnce();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.markdown).toContain('mul 实现为加法');
    expect(posted[0]!.key).toBe(`explain:${FINDING_HIGH}:${CR}`); // high severity first
    expect(posted[0]!.target).toBe('top-level');
  });

  it('行内锚点路径 → 挑该文件的 Finding', async () => {
    const posted: Posted[] = [];
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'explain_finding',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR,
        targetKind: 'review-thread',
        targetNativeId: 't1',
        anchorPath: 'src/util.ts',
      },
      dedupeKey: 'ef-2',
    });
    await supervisor(posted, '这是 util 里的问题').runOnce();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      key: `explain:${FINDING_LOW}:${CR}:thread:t1`,
      target: 'thread',
      nativeId: 't1',
    }); // picks the low util finding by path and replies in its thread
  });

  it('明确 finding 必须属于目标 CR 且达到已验证等级', async () => {
    const otherCr = uuidv7();
    const otherRev = uuidv7();
    const otherFinding = uuidv7();
    await db
      .insertInto('change_requests')
      .values({
        id: otherCr,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: `other-${otherCr}`,
        number: 99,
        kind: 'pull-request',
        source_branch: 'other',
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
        id: otherRev,
        tenant_id: TENANT,
        change_request_id: otherCr,
        base_sha: 'other-base',
        head_sha: `other-${otherRev}`,
        merge_base_sha: null,
        source_branch: 'other',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await seedFinding(db, otherFinding, 'unrelated finding', 'critical', 'src/other.ts', {
      revisionId: otherRev,
    });

    const posted: Posted[] = [];
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'explain_finding',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR,
        targetKind: 'review-thread',
        targetNativeId: 'scope-thread',
        findingId: otherFinding,
      },
      dedupeKey: 'ef-scope',
    });
    await supervisor(posted, 'must not be used').runOnce();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.key).toBe(`explain:none:${CR}:thread:scope-thread`);
    expect(posted[0]!.markdown).not.toContain('must not be used');

    const unverified = uuidv7();
    await seedFinding(db, unverified, 'unverified claim', 'critical', 'src/unverified.ts', {
      confirmation: 'hypothesis',
    });
    const unverifiedPosted: Posted[] = [];
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'explain_finding',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR,
        targetKind: 'review-thread',
        targetNativeId: 'unverified-thread',
        findingId: unverified,
      },
      dedupeKey: 'ef-unverified',
    });
    await supervisor(unverifiedPosted, 'must not be used').runOnce();
    expect(unverifiedPosted[0]!.key).toBe(`explain:none:${CR}:thread:unverified-thread`);
  });

  it('publication_records 使重复 explain Job 不会重复发评论', async () => {
    const posted: Posted[] = [];
    const payload = {
      tenantId: TENANT,
      repositoryId: REPO,
      changeRequestId: CR,
      targetKind: 'review-thread' as const,
      targetNativeId: 'idem-thread',
      findingId: FINDING_HIGH,
    };
    for (const key of ['ef-idem-1', 'ef-idem-2']) {
      await enqueueJob(db, {
        tenantId: TENANT,
        type: 'explain_finding',
        payload,
        dedupeKey: key,
      });
      await supervisor(posted, 'idempotent explanation').runOnce();
    }
    expect(posted).toHaveLength(1);
    const record = await db
      .selectFrom('publication_records')
      .select(['state', 'provider_native_id'])
      .where('idempotency_key', '=', `explain:${FINDING_HIGH}:${CR}:thread:idem-thread`)
      .executeTakeFirstOrThrow();
    expect(record).toEqual({ state: 'published', provider_native_id: 'r1' });
  });

  /*
   * The idempotency key includes the triggering comment id: otherwise a second `@winnowl explain`
   * hits the earlier publication record and is skipped. Retries of one request reuse the key.
   */
  it('再问一遍 → 新答案;同一请求重试 → 不重复发', async () => {
    const posted: Posted[] = [];
    const base = {
      tenantId: TENANT,
      repositoryId: REPO,
      changeRequestId: CR,
      targetKind: 'change-request' as const,
      targetNativeId: '42',
      findingId: FINDING_HIGH,
    };
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'explain_finding',
      payload: { ...base, requestId: 'comment-1' },
      dedupeKey: 'ef-req-1',
    });
    await supervisor(posted, '第一次解释').runOnce();
    // A retry of the same request: same key, nothing posted.
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'explain_finding',
      payload: { ...base, requestId: 'comment-1' },
      dedupeKey: 'ef-req-1-retry',
    });
    await supervisor(posted, '重复的解释').runOnce();
    expect(posted).toHaveLength(1);

    // A new comment asking again gets a new key and a new answer.
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'explain_finding',
      payload: { ...base, requestId: 'comment-2' },
      dedupeKey: 'ef-req-2',
    });
    await supervisor(posted, '第二次解释').runOnce();
    expect(posted).toHaveLength(2);
    expect(posted[0]!.markdown).toContain('第一次解释');
    expect(posted[1]!.markdown).toContain('第二次解释');
    expect(posted[1]!.key).toBe(`explain:${FINDING_HIGH}:${CR}:comment-2`);
  });

  it('explainer 未完成 → 兜底文案含 claim', async () => {
    const posted: Posted[] = [];
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'explain_finding',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR,
        targetKind: 'review-thread',
        targetNativeId: 'fallback-thread',
      },
      dedupeKey: 'ef-3',
    });
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant('no tool call')]); // no finalization tool call
    const handler = createExplainFindingHandler({
      bundle,
      modelSource: () => ({ model: faux.model, streamFn: faux.streamFn }),
      buildProvider: async () => provider(posted),
    });
    await new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { explain_finding: handler },
    }).runOnce();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.markdown).toContain('mul returns a+b');
  });
});
