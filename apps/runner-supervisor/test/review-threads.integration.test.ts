import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { DiscussionThread, SourceControlProvider } from '@reviewbot/provider-contracts';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createReviewThreadResolver } from '../src/review-threads.js';
import type { ReviewRevisionContext } from '../src/review-revision.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();
const FIXED = uuidv7();
const OPEN = uuidv7();
const CR_REF = { id: CR, repositoryId: REPO, nativeId: '42', number: 42, kind: 'pull-request' as const };

function ctx(db: Db): ReviewRevisionContext {
  return {
    payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: CR, revisionId: REV, headSha: 'abcdef1234567', configDigest: '' },
    changeRequest: CR_REF,
    providerHostId: HOST,
    db,
  } as unknown as ReviewRevisionContext;
}

function thread(nativeId: string, body: string, opts: { isBot?: boolean; resolved?: boolean } = {}): DiscussionThread {
  return {
    ref: { nativeId: `t-${nativeId}`, changeRequest: CR_REF },
    resolved: opts.resolved ?? false,
    comments: [{ nativeId, author: { id: '1', login: 'winnowl[bot]' }, body, createdAt: '', isBot: opts.isBot ?? true }],
  } as DiscussionThread;
}

function fakeProvider(threads: DiscussionThread[], resolvableThreads = true) {
  const edits: { nativeId: string; markdown: string }[] = [];
  const resolved: string[] = [];
  const provider = {
    capabilities: { forChangeRequest: async () => ({ resolvableThreads }) },
    discussions: {
      listThreads: async () => threads,
      editComment: async (c: { nativeId: string }, b: { markdown: string }) => void edits.push({ nativeId: c.nativeId, markdown: b.markdown }),
      resolve: async (t: { nativeId: string }) => void resolved.push(t.nativeId),
    },
  } as unknown as SourceControlProvider;
  return { provider, edits, resolved };
}

const outcome = { resolvedFindingIds: [FIXED] } as unknown as ReviewOutcome;

describe('门禁对账确认已修 → 注明并 resolve bot 线程(§24.5)', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    const now = new Date();
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: now }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: now }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: now }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: now }).execute();
    await db.insertInto('change_requests').values({ id: CR, tenant_id: TENANT, repository_id: REPO, native_id: '42', number: 42, kind: 'pull-request', source_branch: 'feat', target_branch: 'main', state: 'open', draft: false, created_at: now, updated_at: now }).execute();
    await db.insertInto('revisions').values({ id: REV, tenant_id: TENANT, change_request_id: CR, base_sha: 'base', head_sha: 'abcdef1234567', merge_base_sha: null, source_branch: 'feat', target_branch: 'main', created_at: now }).execute();
    for (const id of [FIXED, OPEN]) {
      await db.insertInto('findings').values({ id, tenant_id: TENANT, repository_id: REPO, semantic_fingerprint: `fp-${id}`, category: 'correctness', canonical_claim: id, lifecycle: 'published', first_seen_at: now, last_seen_at: now }).execute();
    }
    // FIXED got an inline comment in both rounds (re-posted after the anchor moved); OPEN is still unfixed.
    const records: [string, string][] = [[FIXED, '101'], [FIXED, '102'], [OPEN, '201']];
    for (const [findingId, nativeId] of records) {
      await db.insertInto('publication_records').values({ id: uuidv7(), tenant_id: TENANT, repository_id: REPO, change_request_id: CR, revision_id: REV, finding_id: findingId, provider_host_id: HOST, kind: 'inline', idempotency_key: `k-${nativeId}`, provider_native_id: nativeId, provider_url: null, state: 'published', request_digest: 'd', created_at: now, updated_at: now }).execute();
    }
  });

  afterAll(async () => {
    await stop?.();
  });

  it('只处理已修 finding 的 bot 线程;每条追加一次注记并 resolve', async () => {
    const { provider, edits, resolved } = fakeProvider([thread('101', 'first'), thread('102', 'second'), thread('201', 'still open')]);
    await createReviewThreadResolver({ buildProvider: async () => provider })(outcome, ctx(db));
    expect(edits.map((e) => e.nativeId).sort()).toEqual(['101', '102']);
    expect(edits[0]!.markdown).toMatch(/^first\n\n---\n✅ Addressed in abcdef1 .*\n<!-- winnowl:resolved -->$/);
    expect(resolved.sort()).toEqual(['t-101', 't-102']);
  });

  it('已带 marker 不重复追加;已 resolve 与人类评论不碰', async () => {
    const { provider, edits, resolved } = fakeProvider([
      thread('101', 'first\n\n<!-- winnowl:resolved -->'),
      thread('102', 'second', { resolved: true }),
      thread('201', 'x', { isBot: false }),
    ]);
    await createReviewThreadResolver({ buildProvider: async () => provider })(outcome, ctx(db));
    expect(edits).toEqual([]);
    expect(resolved).toEqual(['t-101']);
  });

  it('平台不支持 resolvable threads → 只追加注记', async () => {
    const { provider, edits, resolved } = fakeProvider([thread('101', 'first')], false);
    await createReviewThreadResolver({ buildProvider: async () => provider })(outcome, ctx(db));
    expect(edits.map((e) => e.nativeId)).toEqual(['101']);
    expect(resolved).toEqual([]);
  });
});
