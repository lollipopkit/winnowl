import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createReviewFindingsWriter } from '../src/review-findings.js';
import type { ReviewRevisionContext } from '../src/review-revision.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();

function finding(
  claim: string,
  opts: { suppressed?: boolean; placement?: 'inline' | 'folded'; status?: 'confirmed' | 'uncertain'; severity?: string; demotions?: string[] } = {},
): unknown {
  const status = opts.status ?? 'confirmed';
  return {
    candidateId: uuidv7(),
    claim,
    category: 'correctness',
    primaryAnchorText: `code for ${claim}`,
    placement: opts.placement ?? 'inline',
    decision: { status, kind: 'defect', placement: opts.placement ?? 'inline', blocking: status === 'confirmed' },
    verdict: {
      severity: opts.severity ?? 'high',
      confirmation: 'independently-verified',
      changeRelation: 'introduced',
      decision: 'accept',
      actionable: true,
    },
    anchor: { path: 'src/x.ts', side: 'head', line: 7 },
    ...(opts.demotions ? { demotions: opts.demotions } : {}),
    ...(opts.suppressed ? { suppressed: true } : {}),
  };
}

function ctx(db: Db): ReviewRevisionContext {
  return {
    payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: CR, revisionId: REV, headSha: 'head-1', configDigest: '' },
    changeRequest: { id: CR, repositoryId: REPO, nativeId: '42', number: 42, kind: 'pull-request' },
    providerHostId: HOST,
    db,
  } as unknown as ReviewRevisionContext;
}

describe('review 完成 → 写 findings 表(§17/§24)', () => {
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

  /*
   * Suppressed findings are stored as retracted: the console's suppressed view reads them, and retracted
   * is not an active lifecycle, so a later confirmation is not mistaken for a recurrence.
   */
  it('finding 落 findings + occurrence;被压制的记 retracted / state=suppressed', async () => {
    const outcome = {
      candidateCount: 3,
      coverage: { scopesTotal: 1, scopesComplete: 1 },
      publishedInline: 2,
      findings: [finding('off-by-one in add'), finding('mul returns sum'), finding('style nit', { suppressed: true })],
    } as unknown as ReviewOutcome;

    await createReviewFindingsWriter()(outcome, ctx(db));

    const findings = await db.selectFrom('findings').selectAll().where('repository_id', '=', REPO).execute();
    expect(findings).toHaveLength(3);
    expect(findings.filter((f) => f.lifecycle === 'new')).toHaveLength(2);
    expect(findings.filter((f) => f.lifecycle === 'retracted')).toHaveLength(1); // suppressed ones stay out of the active set
    const occ = await db.selectFrom('finding_occurrences').selectAll().where('revision_id', '=', REV).execute();
    expect(occ).toHaveLength(3);
    expect(occ.filter((o) => o.state === 'suppressed')).toHaveLength(1);
    expect(occ.every((o) => o.severity === 'high' && o.confirmation === 'independently-verified')).toBe(true);
  });

  it('重复 review(同 revision)→ upsert 幂等(不重复建 finding/occurrence)', async () => {
    const outcome = { candidateCount: 1, coverage: { scopesTotal: 1, scopesComplete: 1 }, publishedInline: 1, findings: [finding('off-by-one in add')] } as unknown as ReviewOutcome;
    await createReviewFindingsWriter()(outcome, ctx(db));
    const findings = await db.selectFrom('findings').selectAll().where('repository_id', '=', REPO).execute();
    expect(findings).toHaveLength(3); // still 3: the same fingerprint upserts
  });

  it('publication_records 的 candidate id → 换成真实 finding id(否则按评论反查 finding 永远 join 不上)', async () => {
    // Publishing precedes storage and uses the candidate id; storage rewrites it to the findings key.
    const f = finding('shared buffer across calls') as { candidateId: string };
    await db
      .insertInto('publication_records')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        repository_id: REPO,
        change_request_id: CR,
        finding_id: f.candidateId, // candidate id written at publish time
        revision_id: REV,
        provider_host_id: HOST,
        kind: 'inline',
        idempotency_key: `inline:${f.candidateId}:${REV}`,
        provider_native_id: 'c-remap',
        provider_url: null,
        state: 'published',
        request_digest: '',
        response: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    const outcome = { candidateCount: 1, coverage: { scopesTotal: 1, scopesComplete: 1 }, publishedInline: 1, findings: [f] } as unknown as ReviewOutcome;
    await createReviewFindingsWriter()(outcome, ctx(db));

    const rec = await db.selectFrom('publication_records').selectAll().where('provider_native_id', '=', 'c-remap').executeTakeFirstOrThrow();
    expect(rec.finding_id).not.toBe(f.candidateId);
    // Points at a real findings row, which resolveFeedbackTarget joins on.
    const row = await db.selectFrom('findings').selectAll().where('id', '=', rec.finding_id!).executeTakeFirstOrThrow();
    expect(row.canonical_claim).toBe('shared buffer across calls');
  });

  /*
   * `state` flattens the three publication axes (status/kind/placement). Its values must stay stable
   * so historical rows remain comparable.
   */
  it('occurrence.state 由三轴展平:确认 inline/折叠、未确认按严重度分两区', async () => {
    const rev2 = uuidv7();
    await db
      .insertInto('revisions')
      .values({ id: rev2, tenant_id: TENANT, change_request_id: CR, base_sha: 'base', head_sha: 'head-2', merge_base_sha: null, source_branch: 'feat', target_branch: 'main', created_at: new Date() })
      .execute();
    const outcome = {
      candidateCount: 4,
      coverage: { scopesTotal: 1, scopesComplete: 1 },
      publishedInline: 1,
      findings: [
        finding('state inline case'),
        finding('state folded case', { placement: 'folded', demotions: ['low-severity', 'inline-budget'] }),
        finding('state high uncertain', { status: 'uncertain', placement: 'folded', severity: 'high' }),
        finding('state low uncertain', { status: 'uncertain', placement: 'folded', severity: 'low' }),
      ],
    } as unknown as ReviewOutcome;

    const c = ctx(db);
    (c.payload as { revisionId: string }).revisionId = rev2;
    await createReviewFindingsWriter()(outcome, c);

    const occ = await db.selectFrom('finding_occurrences').selectAll().where('revision_id', '=', rev2).execute();
    const byClaim = new Map(
      await Promise.all(
        occ.map(async (o) => {
          const f = await db.selectFrom('findings').select('canonical_claim').where('id', '=', o.finding_id).executeTakeFirstOrThrow();
          return [f.canonical_claim, o] as const;
        }),
      ),
    );
    expect(byClaim.get('state inline case')!.state).toBe('inline');
    expect(byClaim.get('state folded case')!.state).toBe('summary');
    expect(byClaim.get('state high uncertain')!.state).toBe('unverified-risks');
    expect(byClaim.get('state low uncertain')!.state).toBe('low-evidence');
    // The downgrade reason chain is stored, so why a finding was collapsed stays answerable.
    expect(byClaim.get('state folded case')!.demotions).toEqual(['low-severity', 'inline-budget']);
    expect(byClaim.get('state inline case')!.demotions).toEqual([]);
  });
});
