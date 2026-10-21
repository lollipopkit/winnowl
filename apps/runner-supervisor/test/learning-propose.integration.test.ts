import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFauxAgent, type ResolvedModelSource } from '@reviewbot/agent-pi';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { billRevision, createLearningProposeHandler } from '../src/learning-propose.js';
import type { JobHandler } from '../src/supervisor.js';

function run(handler: JobHandler, db: Db, payload: unknown): Promise<unknown> {
  return handler({ job: { payload } as never, db, log: () => undefined } as unknown as Parameters<JobHandler>[0]);
}

/** faux model source; triage and draft share one response queue consumed in order. */
function source(faux: ReturnType<typeof createFauxAgent>): ResolvedModelSource {
  return { model: faux.model, streamFn: faux.streamFn } as ResolvedModelSource;
}

async function seedTenant(db: Db, tenantId: string): Promise<string> {
  const host = uuidv7();
  const install = uuidv7();
  const repo = uuidv7();
  await db.insertInto('tenants').values({ id: tenantId, name: tenantId.slice(0, 6), region: null, created_at: new Date() }).execute();
  await db.insertInto('provider_hosts').values({ id: host, tenant_id: tenantId, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
  await db.insertInto('installations').values({ id: install, tenant_id: tenantId, provider_host_id: host, native_id: '1', account_login: 'a', status: 'active', created_at: new Date() }).execute();
  await db.insertInto('repositories').values({ id: repo, tenant_id: tenantId, provider_host_id: host, installation_id: install, native_id: '1', namespace: 'a', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
  return repo;
}

async function seedReviewCost(db: Db, tenantId: string, repoId: string, revId: string, totalTokens: number): Promise<void> {
  await db
    .insertInto('review_costs')
    .values({ id: uuidv7(), tenant_id: tenantId, repository_id: repoId, change_request_id: null, revision_id: revId, input_tokens: totalTokens, output_tokens: 0, total_tokens: totalTokens, cost_usd: '0.05', candidate_count: 0, published_inline: 0, created_at: new Date() })
    .execute();
}

function triageDraftFaux(worth: boolean, candidate?: { broadness: 'repository' | 'organization'; instruction: string }) {
  const f = createFauxAgent();
  const steps = [f.assistant(f.toolCall('submit_triage', { worthLearning: worth, note: 'n' }))];
  if (worth && candidate) {
    steps.push(f.assistant(f.toolCall('submit_finding', { broadness: candidate.broadness, instruction: candidate.instruction, rationale: 'r', locality: 'none', confidence: 0.8 })));
  }
  f.setResponses(steps);
  return f;
}

const TENANT = uuidv7();
const REV = uuidv7();
const REV_BILL = uuidv7();

describe('learning_propose handler(§租户级自动提案)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let repo: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    repo = await seedTenant(db, TENANT);
    await seedReviewCost(db, TENANT, repo, REV, 1000);
    await seedReviewCost(db, TENANT, repo, REV_BILL, 1000);
  });
  afterAll(async () => {
    await stop?.();
  });

  async function countProposals(instruction: string): Promise<number> {
    const rows = await db.selectFrom('learning_proposals').select('id').where('tenant_id', '=', TENANT).where('instruction', '=', instruction).execute();
    return rows.length;
  }

  it('triage yes → repository 提案(proposedBy=auto,rationale 含自评置信度)', async () => {
    const handler = createLearningProposeHandler({ resolveModel: () => source(triageDraftFaux(true, { broadness: 'repository', instruction: '本仓规则 R1' })) });
    await run(handler, db, { tenantId: TENANT, repositoryId: repo, revisionId: REV });
    const row = await db.selectFrom('learning_proposals').selectAll().where('tenant_id', '=', TENANT).where('instruction', '=', '本仓规则 R1').executeTakeFirst();
    expect(row).toBeTruthy();
    expect(row!.broadness).toBe('repository');
    expect(row!.repository_id).toBe(repo);
    expect(row!.proposed_by).toBe('auto');
    expect(row!.status).toBe('proposed');
    expect(row!.rationale).toContain('自评置信度');
  });

  it('dedup:同 instruction 再来一次 → 不重复插', async () => {
    const handler = createLearningProposeHandler({ resolveModel: () => source(triageDraftFaux(true, { broadness: 'repository', instruction: '本仓规则 R1' })) });
    await run(handler, db, { tenantId: TENANT, repositoryId: repo, revisionId: uuidv7() });
    expect(await countProposals('本仓规则 R1')).toBe(1);
  });

  it('draft organization → repository_id null(owner 才能批,由 canApprove 门控)', async () => {
    const handler = createLearningProposeHandler({ resolveModel: () => source(triageDraftFaux(true, { broadness: 'organization', instruction: '组织规则 O1' })) });
    await run(handler, db, { tenantId: TENANT, repositoryId: repo, revisionId: uuidv7() });
    const row = await db.selectFrom('learning_proposals').selectAll().where('tenant_id', '=', TENANT).where('instruction', '=', '组织规则 O1').executeTakeFirst();
    expect(row!.broadness).toBe('organization');
    expect(row!.repository_id).toBeNull();
  });

  it('triage no → 不产提案', async () => {
    const handler = createLearningProposeHandler({ resolveModel: () => source(triageDraftFaux(false)) });
    await run(handler, db, { tenantId: TENANT, repositoryId: repo, revisionId: uuidv7() });
    expect(await countProposals('不该出现')).toBe(0);
  });

  it('配额超额(reject)→ 跳过、不产提案', async () => {
    const tenantB = uuidv7();
    const repoB = await seedTenant(db, tenantB);
    // tiny plan (token quota 1) + reject subscription + usage 100 → over quota → block.
    const planId = uuidv7();
    await db.insertInto('plans').values({ id: planId, key: `tiny-${planId.slice(0, 8)}`, name: 'tiny', model_tier: 'cheap', monthly_review_quota: null, monthly_token_quota: 1, max_concurrency: 4, features: {}, active: true, created_at: new Date() }).execute();
    await db.insertInto('subscriptions').values({ id: uuidv7(), tenant_id: tenantB, plan_id: planId, status: 'active', overage_policy: 'reject', current_period_start: new Date(), current_period_end: null, created_at: new Date(), updated_at: new Date() }).execute();
    await seedReviewCost(db, tenantB, repoB, uuidv7(), 100);

    const handler = createLearningProposeHandler({ resolveModel: () => source(triageDraftFaux(true, { broadness: 'repository', instruction: 'B 规则' })) });
    await run(handler, db, { tenantId: tenantB, repositoryId: repoB, revisionId: uuidv7() });
    const rows = await db.selectFrom('learning_proposals').select('id').where('tenant_id', '=', tenantB).execute();
    expect(rows).toHaveLength(0); // blocked: nothing proposed
  });

  it('billRevision:用量累加到该 revision 的 review_costs 行(计入配额)', async () => {
    await billRevision(db, REV_BILL, { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.02 });
    const row = await db.selectFrom('review_costs').select(['input_tokens', 'total_tokens', 'cost_usd']).where('revision_id', '=', REV_BILL).executeTakeFirstOrThrow();
    expect(Number(row.total_tokens)).toBe(1015); // 1000 + 15
    expect(Number(row.input_tokens)).toBe(1010); // 1000 + 10
    expect(Number(row.cost_usd)).toBeCloseTo(0.07, 2); // 0.05 + 0.02
  });

  // Each review of a revision has its own row; usage goes to the latest, and concurrent finishes are not lost.
  it('billRevision:同 revision 多行时只累加到最近一行,并发调用不丢账', async () => {
    const rev = uuidv7();
    const repo = (await db.selectFrom('repositories').select('id').where('tenant_id', '=', TENANT).executeTakeFirstOrThrow()).id;
    await seedReviewCost(db, TENANT, repo, rev, 100);
    await new Promise((r) => setTimeout(r, 5));
    await seedReviewCost(db, TENANT, repo, rev, 200);
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01 };
    await Promise.all([billRevision(db, rev, usage), billRevision(db, rev, usage), billRevision(db, rev, usage)]);
    const rows = await db.selectFrom('review_costs').select('total_tokens').where('revision_id', '=', rev).orderBy('created_at').execute();
    expect(rows.map((r) => Number(r.total_tokens))).toEqual([100, 206]);
  });
});
