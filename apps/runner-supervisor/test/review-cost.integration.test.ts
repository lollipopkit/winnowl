import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createReviewCostWriter } from '../src/review-cost.js';
import type { ReviewRevisionContext } from '../src/review-revision.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();

function ctx(db: Db): ReviewRevisionContext {
  return {
    payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: CR, revisionId: REV, headSha: 'head-1', configDigest: '' },
    changeRequest: { id: CR, repositoryId: REPO, nativeId: '42', number: 42, kind: 'pull-request' },
    providerHostId: HOST,
    db,
  } as unknown as ReviewRevisionContext;
}

function outcome(usage: ReviewOutcome['usage']): ReviewOutcome {
  return {
    candidateCount: 4,
    coverage: { scopesTotal: 2, scopesComplete: 2 },
    publishedInline: 3,
    findings: [],
    ...(usage ? { usage } : {}),
  } as ReviewOutcome;
}

describe('review 完成 → 写 review_costs 表(§44)', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    await db.insertInto('change_requests').values({ id: CR, tenant_id: TENANT, repository_id: REPO, native_id: '42', number: 42, kind: 'pull-request', source_branch: 'feat', target_branch: 'main', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() }).execute();
    await db.insertInto('revisions').values({ id: REV, tenant_id: TENANT, change_request_id: CR, base_sha: 'base', head_sha: 'head-1', merge_base_sha: null, source_branch: 'feat', target_branch: 'main', created_at: new Date() }).execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  it('有 usage → 落一行(token/成本/候选数)', async () => {
    await createReviewCostWriter()(
      outcome({ inputTokens: 1200, outputTokens: 340, totalTokens: 1540, costUsd: 0.0123 }),
      ctx(db),
    );
    const rows = await db.selectFrom('review_costs').selectAll().where('revision_id', '=', REV).execute();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.input_tokens)).toBe(1200);
    expect(Number(rows[0]!.output_tokens)).toBe(340);
    expect(Number(rows[0]!.total_tokens)).toBe(1540);
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.0123, 5);
    expect(rows[0]!.candidate_count).toBe(4);
    expect(rows[0]!.published_inline).toBe(3);
  });

  // Each review of a revision gets its own row, so earlier spend stays in billing, quota and circuit breaking.
  it('同 revision 再评一次 → 新增一行,前一次的用量照常在账', async () => {
    await createReviewCostWriter()(
      outcome({ inputTokens: 2000, outputTokens: 500, totalTokens: 2500, costUsd: 0.02 }),
      ctx(db),
    );
    const rows = await db.selectFrom('review_costs').selectAll().where('revision_id', '=', REV).orderBy('created_at').execute();
    expect(rows.map((r) => Number(r.total_tokens))).toEqual([1540, 2500]);
  });

  it('插件外呼平台成本计入 cost_usd(§插件⑤:audit plugin.call 的 costUsd 按 revision 汇总;tenant key 计 0)', async () => {
    // Two platform-key exa calls ($0.007+$0.001) + one tenant-key call (0) + one keyless context7 call (0).
    const mk = (detail: Record<string, unknown>) =>
      db.insertInto('audit_events').values({ id: uuidv7(), tenant_id: TENANT, actor: 'review', action: 'plugin.call', target: REPO, detail, created_at: new Date() }).execute();
    await mk({ plugin: 'exa', tool: 'web_search', revisionId: REV, keySource: 'platform', costUsd: 0.007 });
    await mk({ plugin: 'exa', tool: 'fetch_url', revisionId: REV, keySource: 'platform', costUsd: 0.001 });
    await mk({ plugin: 'exa', tool: 'web_search', revisionId: REV, keySource: 'tenant', costUsd: 0 });
    await mk({ plugin: 'context7', tool: 'query_docs', revisionId: REV, keySource: 'none', costUsd: 0 });
    // Calls of other revisions are not counted.
    await mk({ plugin: 'exa', tool: 'web_search', revisionId: uuidv7(), keySource: 'platform', costUsd: 0.007 });

    const latest = () =>
      db.selectFrom('review_costs').selectAll().where('revision_id', '=', REV).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    await createReviewCostWriter()(outcome({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.1 }), ctx(db));
    expect(Number((await latest()).cost_usd)).toBeCloseTo(0.108, 6);
    // The next review counts only plugin calls made after it started.
    await mk({ plugin: 'exa', tool: 'web_search', revisionId: REV, keySource: 'platform', costUsd: 0.003 });
    await createReviewCostWriter()(outcome({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.1 }), ctx(db));
    expect(Number((await latest()).cost_usd)).toBeCloseTo(0.103, 6);
  });

  it('分阶段用量落 stage_usage(§44 Phase 0:回答"钱花在哪一段")', async () => {
    const REV2 = uuidv7();
    await db.insertInto('revisions').values({ id: REV2, tenant_id: TENANT, change_request_id: CR, base_sha: 'b', head_sha: 'head-stage', merge_base_sha: null, source_branch: 'feat', target_branch: 'main', created_at: new Date() }).execute();
    const o = {
      ...outcome({ inputTokens: 1000, outputTokens: 200, totalTokens: 1200, costUsd: 1.2 }),
      stageUsage: {
        map: { inputTokens: 200, outputTokens: 40, totalTokens: 240, costUsd: 0.2 },
        dig: { inputTokens: 300, outputTokens: 60, totalTokens: 360, costUsd: 0.3 },
        verify: { inputTokens: 500, outputTokens: 100, totalTokens: 600, costUsd: 0.7 },
      },
      stageMs: { prepare: 1200, map: 3000, dig: 9000, publish: 400, total: 13600 },
    } as ReviewOutcome;
    const c = ctx(db);
    (c.payload as { revisionId: string }).revisionId = REV2;
    await createReviewCostWriter()(o, c);
    const row = await db.selectFrom('review_costs').selectAll().where('revision_id', '=', REV2).executeTakeFirstOrThrow();
    const stages = row.stage_usage as Record<string, { costUsd: number }>;
    expect(Object.keys(stages).sort()).toEqual(['dig', 'map', 'verify']); // a single scope has no synthesis stage
    expect(stages.verify!.costUsd).toBe(0.7);
    const verifyShare = stages.verify!.costUsd / Number(row.cost_usd);
    expect(verifyShare).toBeGreaterThan(0.5);
    expect(row.stage_ms).toEqual({ prepare: 1200, map: 3000, dig: 9000, publish: 400, total: 13600 });
  });

  /*
   * Cancelled runs are flagged `cancelled`: usage is billed, but the revision does not count as reviewed
   * (the self-trigger guard looks for a row with cancelled=false).
   */
  it('取消收工 → cancelled=true;已完成的评审不被后来的取消抹掉', async () => {
    const REV3 = uuidv7();
    await db.insertInto('revisions').values({ id: REV3, tenant_id: TENANT, change_request_id: CR, base_sha: 'base', head_sha: 'head-3', merge_base_sha: null, source_branch: 'feat', target_branch: 'main', created_at: new Date() }).execute();
    const c = ctx(db);
    (c.payload as { revisionId: string }).revisionId = REV3;
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.02, turns: 1, cacheReadTokens: 0, reasoningTokens: 0 } as ReviewOutcome['usage'];
    const reviewed = async () =>
      (await db.selectFrom('review_costs').select('id').where('revision_id', '=', REV3).where('cancelled', '=', false).executeTakeFirst()) !== undefined;

    await createReviewCostWriter()({ ...outcome(usage), cancelled: true } as ReviewOutcome, c);
    expect(await reviewed()).toBe(false);
    await createReviewCostWriter()(outcome(usage), c);
    expect(await reviewed()).toBe(true);
    await createReviewCostWriter()({ ...outcome(usage), cancelled: true } as ReviewOutcome, c);
    expect(await reviewed()).toBe(true);
    // All three are billed.
    expect(await db.selectFrom('review_costs').select('id').where('revision_id', '=', REV3).execute()).toHaveLength(3);
  });

  it('无 usage(faux 模型)→ 不落库', async () => {
    const REV2 = uuidv7();
    await db.insertInto('revisions').values({ id: REV2, tenant_id: TENANT, change_request_id: CR, base_sha: 'base', head_sha: 'head-2', merge_base_sha: null, source_branch: 'feat', target_branch: 'main', created_at: new Date() }).execute();
    const c = ctx(db);
    (c.payload as { revisionId: string }).revisionId = REV2;
    await createReviewCostWriter()(outcome(undefined), c);
    const rows = await db.selectFrom('review_costs').selectAll().where('revision_id', '=', REV2).execute();
    expect(rows).toHaveLength(0);
  });
});
