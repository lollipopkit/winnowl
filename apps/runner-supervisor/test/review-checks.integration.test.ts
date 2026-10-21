import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createReviewChecksSubmitter, recomputeReviewGate } from '../src/review-checks.js';
import type { ReviewRevisionContext } from '../src/review-revision.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
/** A PR with one unfixed blocking finding; CLEAN_CR has none. */
const CR = uuidv7();
const CLEAN_CR = uuidv7();

interface CheckCall { name: string; conclusion?: string; title?: string; summary?: string; key: string }

function fakeProvider(calls: CheckCall[]): SourceControlProvider {
  return {
    checks: {
      createOrUpdate: async (
        _repo: unknown,
        input: { name: string; conclusion?: string; title?: string; summary?: string },
        idem: { key: string },
      ) => {
        calls.push({ name: input.name, conclusion: input.conclusion, title: input.title, summary: input.summary, key: idem.key });
        return { nativeId: 'chk1' };
      },
    },
  } as unknown as SourceControlProvider;
}

function outcome(blocking: number, scopesComplete: number, scopesTotal: number): ReviewOutcome {
  const findings = Array.from({ length: blocking }, (_, i) => ({
    candidateId: `f${i}`,
    claim: 'x',
    location: 'inline',
    decision: { blocking: true },
    verdict: { confirmation: 'independently-verified' },
  }));
  return { candidateCount: blocking, findings, coverage: { scopesTotal, scopesComplete }, publishedInline: blocking } as unknown as ReviewOutcome;
}

function ctx(db: Db, cr = CR): ReviewRevisionContext {
  return {
    payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: cr, revisionId: uuidv7(), headSha: 'head-1', configDigest: '' },
    changeRequest: { id: cr, repositoryId: REPO, nativeId: '42', number: 42, kind: 'pull-request' },
    providerHostId: HOST,
    db,
  } as unknown as ReviewRevisionContext;
}

describe('review 完成 → 提交 Check Run', () => {
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
    for (const [id, number] of [[CR, 42], [CLEAN_CR, 43]] as const) {
      await db.insertInto('change_requests').values({ id, tenant_id: TENANT, repository_id: REPO, native_id: String(number), number, kind: 'pull-request', source_branch: null, target_branch: null, state: 'open', draft: false, author: null, author_provider_id: null, created_at: new Date(), updated_at: new Date() }).execute();
    }
    // A blocking finding from an earlier round, still unfixed, counts even though this outcome lacks it.
    const rev = uuidv7();
    await db.insertInto('revisions').values({ id: rev, tenant_id: TENANT, change_request_id: CR, base_sha: 'b', head_sha: 'head-0', merge_base_sha: null, source_branch: null, target_branch: null, created_at: new Date() }).execute();
    const { upsertFinding, recordOccurrence } = await import('@reviewbot/finding-lifecycle');
    const { id } = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: 'fp-prior', category: 'correctness', canonicalClaim: 'bug' });
    await recordOccurrence(db, { tenantId: TENANT, findingId: id, revisionId: rev, state: 'inline', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', blocking: true, refuterUpheld: true });
  });

  afterAll(async () => {
    await stop?.();
  });

  it('上一轮未修的阻断项计入 check,即使本轮没新报;gate 默认不启用 → neutral(含幂等键)', async () => {
    const calls: CheckCall[] = [];
    const submit = createReviewChecksSubmitter({ buildProvider: async () => fakeProvider(calls) });
    await submit(outcome(0, 1, 1), ctx(db));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('winnowl/review');
    expect(calls[0]!.conclusion).toBe('neutral');
    expect(calls[0]!.title).toContain('1 blocking');
    expect(calls[0]!.key).toBe(`check:${CR}:head-1`);
  });

  it('无 blocking + 覆盖完整 → success', async () => {
    const calls: CheckCall[] = [];
    const submit = createReviewChecksSubmitter({ buildProvider: async () => fakeProvider(calls) });
    await submit(outcome(0, 2, 2), ctx(db, CLEAN_CR));
    expect(calls[0]!.conclusion).toBe('success');
  });

  it('coverage gaps are stated in the summary even with the gate disabled', async () => {
    const calls: CheckCall[] = [];
    const submit = createReviewChecksSubmitter({ buildProvider: async () => fakeProvider(calls) });
    await submit({ ...outcome(0, 6, 6), unreachedPaths: ['a', 'b'], unplannedPaths: ['c'] } as ReviewOutcome, ctx(db, CLEAN_CR));
    expect(calls[0]!.conclusion).toBe('neutral');
    expect(calls[0]!.summary).toContain('2 planned file(s) were not explored');
    expect(calls[0]!.summary).toContain('1 changed file(s) were not assigned');
  });

  it('gate 启用 + blocking 达确认等级 → failure', async () => {
    const calls: CheckCall[] = [];
    const submit = createReviewChecksSubmitter({
      buildProvider: async () => fakeProvider(calls),
      mergeGate: { enabled: true, requiredConfirmation: 'independently-verified' },
    });
    await db.insertInto('revisions').values({ id: uuidv7(), tenant_id: TENANT, change_request_id: CR, base_sha: 'b', head_sha: 'head-1', merge_base_sha: null, source_branch: null, target_branch: null, created_at: new Date() }).execute();
    await submit(outcome(1, 1, 1), ctx(db));
    expect(calls[0]!.conclusion).toBe('failure');
    const rev = await db.selectFrom('revisions').select(['gate_state', 'blocking_count']).where('change_request_id', '=', CR).where('head_sha', '=', 'head-1').executeTakeFirstOrThrow();
    expect(rev.gate_state).toBe('block');
    expect(rev.blocking_count).toBeGreaterThan(0);
  });
});

describe('recomputeReviewGate(§26.3 门禁即时翻转)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  const T = uuidv7();
  const H = uuidv7();
  const I = uuidv7();
  const R = uuidv7();
  const CRQ = uuidv7();
  const REV = uuidv7();
  const HEAD = 'head-recompute-1';

  function gateProvider(checks: CheckCall[], events: { event: string; key: string }[]): SourceControlProvider {
    return {
      checks: {
        createOrUpdate: async (_r: unknown, input: { name: string; conclusion?: string }, idem: { key: string }) => {
          checks.push({ name: input.name, conclusion: input.conclusion, key: idem.key });
          return { nativeId: 'c' };
        },
      },
      discussions: {
        createReviewBatch: async (_ref: unknown, review: { event: string }, idem: { key: string }) => {
          events.push({ event: review.event, key: idem.key });
          return { nativeId: 'r' };
        },
      },
    } as unknown as SourceControlProvider;
  }

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: T, name: 'a', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: H, tenant_id: T, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: I, tenant_id: T, provider_host_id: H, native_id: '1', account_login: 'a', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: R, tenant_id: T, provider_host_id: H, installation_id: I, native_id: '9', namespace: 'a', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    await db.insertInto('change_requests').values({ id: CRQ, tenant_id: T, repository_id: R, native_id: '7', number: 7, kind: 'pull-request', source_branch: null, target_branch: null, state: 'open', draft: false, author: null, author_provider_id: null, created_at: new Date(), updated_at: new Date() }).execute();
    await db.insertInto('revisions').values({ id: REV, tenant_id: T, change_request_id: CRQ, base_sha: 'b', head_sha: HEAD, merge_base_sha: null, source_branch: null, target_branch: null, created_at: new Date() }).execute();
    const { upsertFinding, recordOccurrence } = await import('@reviewbot/finding-lifecycle');
    const { id } = await upsertFinding(db, { tenantId: T, repositoryId: R, fingerprint: 'fp1', category: 'correctness', canonicalClaim: 'bug' });
    await recordOccurrence(db, { tenantId: T, findingId: id, revisionId: REV, state: 'inline', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', blocking: true, refuterUpheld: true });
  });

  afterAll(async () => {
    await stop?.();
  });

  const input = { tenantId: T, repositoryId: R, changeRequestId: CRQ, headSha: HEAD, crRef: { id: CRQ, repositoryId: R, nativeId: '7', number: 7, kind: 'pull-request' as const }, autoApprove: true };

  it('仍有 blocking → 翻 check(不阻断默认 gate=neutral),**不** approve 放行', async () => {
    const checks: CheckCall[] = [];
    const events: { event: string; key: string }[] = [];
    await recomputeReviewGate({ db, buildProvider: async () => gateProvider(checks, events) }, input);
    expect(checks).toHaveLength(1);
    expect(events).toHaveLength(0); // blocking > 0: never approve
  });

  it('blocking 被 downgrade(occurrence.blocking=false)→ 零 blocking + head 未移动 → 翻 approve', async () => {
    const { setOccurrenceBlocking, loadChangeRequestBlockingFindings } = await import('@reviewbot/finding-lifecycle');
    const f = (await loadChangeRequestBlockingFindings(db, CRQ))[0]!;
    await setOccurrenceBlocking(db, f.id, f.revisionId, false);
    const checks: CheckCall[] = [];
    const events: { event: string; key: string }[] = [];
    await recomputeReviewGate({ db, buildProvider: async () => gateProvider(checks, events) }, input);
    expect(checks[0]!.conclusion).toBe('success'); // zero blocking and full coverage
    expect(events).toEqual([{ event: 'approve', key: `reverify-gate:${CRQ}:${HEAD}` }]);
  });

  it('head 已移动(新 revision head 不同)→ 即便零 blocking 也不 approve 放行', async () => {
    await db.insertInto('revisions').values({ id: uuidv7(), tenant_id: T, change_request_id: CRQ, base_sha: 'b', head_sha: 'head-moved-2', merge_base_sha: null, source_branch: null, target_branch: null, created_at: new Date() }).execute();
    const checks: CheckCall[] = [];
    const events: { event: string; key: string }[] = [];
    await recomputeReviewGate({ db, buildProvider: async () => gateProvider(checks, events) }, input);
    expect(events).toHaveLength(0); // head moved: no approval, left to the next review
  });
});
