import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  dismissFindingForChangeRequest,
  loadChangeRequestActiveFinding,
  loadChangeRequestBlockingFindings,
  loadActiveFindings,
  recordOccurrence,
  semanticFingerprint,
  setFindingLifecycle,
  upsertFinding,
} from '../src/index.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
/** "This PR"; CR_OTHER is another PR, since history is scoped per CR. */
const CR = uuidv7();
const CR_OTHER = uuidv7();

async function lifecycleOf(db: Db, id: string): Promise<string> {
  const row = await db.selectFrom('findings').select('lifecycle').where('id', '=', id).executeTakeFirstOrThrow();
  return row.lifecycle;
}

/** Occurrences need a real revision: history scope is resolved via revision -> CR. */
async function newRevision(db: Db, changeRequestId: string): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('revisions')
    .values({ id, tenant_id: TENANT, change_request_id: changeRequestId, base_sha: 'b', head_sha: id, merge_base_sha: null, source_branch: null, target_branch: null, created_at: new Date() })
    .execute();
  return id;
}

describe('finding lifecycle 持久化与增量', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'a', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '9', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    for (const [id, number] of [
      [CR, 1],
      [CR_OTHER, 2],
    ] as const) {
      await db
        .insertInto('change_requests')
        .values({ id, tenant_id: TENANT, repository_id: REPO, native_id: String(number), number, kind: 'pull_request', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() })
        .execute();
    }
  });

  afterAll(async () => {
    await stop?.();
  });

  const fp = semanticFingerprint({ repositoryId: REPO, category: 'correctness', claim: 'off-by-one', codeWindow: 'return x + 1' });

  it('首次上报:isNew,记录 occurrence', async () => {
    const rev1 = await newRevision(db, CR);
    const { id, isNew } = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fp, category: 'correctness', canonicalClaim: 'off-by-one' });
    expect(isNew).toBe(true);
    await recordOccurrence(db, { tenantId: TENANT, findingId: id, revisionId: rev1, state: 'published', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', anchor: { line: 10, path: 'a.ts' } });
    const active = await loadActiveFindings(db, REPO, CR);
    expect(active).toHaveLength(1);
    expect(active[0]!.lastLine).toBe(10);
    // Files skipped by an incremental review carry prior findings into the summary via these fields.
    expect(active[0]).toMatchObject({ state: 'published', severity: 'high', path: 'a.ts' });
    expect(await loadActiveFindings(db, REPO, CR_OTHER)).toHaveLength(0); // not visible on another PR
  });

  it('新 Revision 仍在(移动)→ moved,不重复新建', async () => {
    const rev2 = await newRevision(db, CR);
    const prior = await loadActiveFindings(db, REPO, CR);
    const { id, isNew } = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fp, category: 'correctness', canonicalClaim: 'off-by-one' });
    expect(isNew).toBe(false);
    await recordOccurrence(db, { tenantId: TENANT, findingId: id, revisionId: rev2, state: 'persisted', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', anchor: { line: 14, path: 'a.ts' } });

    expect(prior[0]!.lastLine).toBe(10);
    expect((await loadActiveFindings(db, REPO, CR))[0]!.lastLine).toBe(14); // moved, same findings row
    await setFindingLifecycle(db, id, 'moved');
    expect(await lifecycleOf(db, id)).toBe('moved');
  });

  it('新 Revision 已修复(确认)→ resolved', async () => {
    // Fix confirmation lives in review-orchestrator; this only checks the storage side.
    const findingId = (await db.selectFrom('findings').select('id').where('semantic_fingerprint', '=', fp).executeTakeFirstOrThrow()).id;
    await setFindingLifecycle(db, findingId, 'resolved');
    expect(await loadActiveFindings(db, REPO, CR)).toHaveLength(0);
  });

  it('loadChangeRequestBlockingFindings:仅最近 occurrence 为 blocking 的活跃 finding + anchorText/path(0036)', async () => {
    const fpB = semanticFingerprint({ repositoryId: REPO, category: 'correctness', claim: 'null deref', codeWindow: 'x.y' });
    const fpN = semanticFingerprint({ repositoryId: REPO, category: 'style', claim: 'naming', codeWindow: 'v' });
    const rev = await newRevision(db, CR);
    const b = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fpB, category: 'correctness', canonicalClaim: 'null deref on x.y' });
    await recordOccurrence(db, { tenantId: TENANT, findingId: b.id, revisionId: rev, state: 'published', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', anchor: { line: 5, path: 'z.ts' }, anchorText: 'x.y.z', blocking: true, refuterUpheld: true });
    const n = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fpN, category: 'style', canonicalClaim: 'naming' });
    await recordOccurrence(db, { tenantId: TENANT, findingId: n.id, revisionId: rev, state: 'summary', severity: 'low', changeRelation: 'introduced', confirmation: 'code-supported', anchor: { line: 9, path: 'z.ts' }, anchorText: 'v', blocking: false });

    const blocking = await loadChangeRequestBlockingFindings(db, CR);
    const fps = blocking.map((f) => f.fingerprint);
    expect(fps).toContain(fpB);
    expect(fps).not.toContain(fpN);
    const bf = blocking.find((f) => f.fingerprint === fpB)!;
    expect(bf.anchorText).toBe('x.y.z');
    expect(bf.path).toBe('z.ts');
    expect(bf.claim).toBe('null deref on x.y');
  });

  it('loadChangeRequestActiveFinding:点名的一条不论是否阻断都取得到;忽略过的、别的 PR 的取不到', async () => {
    const fpNit = semanticFingerprint({ repositoryId: REPO, category: 'maintainability', claim: 'nit to challenge', codeWindow: 'n()' });
    const rev = await newRevision(db, CR);
    const nit = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fpNit, category: 'maintainability', canonicalClaim: 'nit to challenge' });
    await recordOccurrence(db, { tenantId: TENANT, findingId: nit.id, revisionId: rev, state: 'published', severity: 'low', changeRelation: 'introduced', confirmation: 'independently-verified', anchor: { line: 2, path: 'n.ts' }, anchorText: 'n()', blocking: false });

    expect(await loadChangeRequestActiveFinding(db, CR, nit.id)).toMatchObject({ id: nit.id, path: 'n.ts', line: 2, anchorText: 'n()', revisionId: rev });
    expect(await loadChangeRequestActiveFinding(db, CR_OTHER, nit.id)).toBeUndefined();
    await dismissFindingForChangeRequest(db, { tenantId: TENANT, findingId: nit.id, changeRequestId: CR, actor: 't' });
    expect(await loadChangeRequestActiveFinding(db, CR, nit.id)).toBeUndefined();
  });

  // Old preexisting occurrences may still have blocking=true; the read side filters by change_relation.
  it('存量 blocking=true 的 preexisting occurrence 不进门禁', async () => {
    const fpP = semanticFingerprint({ repositoryId: REPO, category: 'security', claim: 'legacy preexisting', codeWindow: 'old()' });
    const rev = await newRevision(db, CR);
    const p = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fpP, category: 'security', canonicalClaim: '老代码里的注入点' });
    await recordOccurrence(db, { tenantId: TENANT, findingId: p.id, revisionId: rev, state: 'published', severity: 'high', changeRelation: 'preexisting-relevant', confirmation: 'independently-verified', anchor: { line: 3, path: 'legacy.ts' }, anchorText: 'old()', blocking: true, refuterUpheld: true });

    expect((await loadChangeRequestBlockingFindings(db, CR)).map((f) => f.fingerprint)).not.toContain(fpP);
    // With block_preexisting=true the same occurrence gates again without a new review.
    expect(
      (await loadChangeRequestBlockingFindings(db, CR, { blockPreexisting: true })).map((f) => f.fingerprint),
    ).toContain(fpP);
  });

  // Regression: history was loaded per repo, so one PR's blocking findings gated an unrelated PR.
  it('跨 PR 隔离:别的 CR 的 blocking 不进本 CR 的门禁与历史', async () => {
    const fpX = semanticFingerprint({ repositoryId: REPO, category: 'security', claim: 'secret leak', codeWindow: 'println!(secret)' });
    const revOther = await newRevision(db, CR_OTHER);
    const x = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fpX, category: 'security', canonicalClaim: 'config show 打印 jwt_secret' });
    await recordOccurrence(db, { tenantId: TENANT, findingId: x.id, revisionId: revOther, state: 'published', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', anchor: { line: 226, path: 'cli.rs' }, anchorText: 'println!(secret)', blocking: true, refuterUpheld: true });

    expect((await loadChangeRequestBlockingFindings(db, CR_OTHER)).map((f) => f.fingerprint)).toContain(fpX);
    expect((await loadChangeRequestBlockingFindings(db, CR)).map((f) => f.fingerprint)).not.toContain(fpX);
    expect((await loadActiveFindings(db, REPO, CR)).map((f) => f.fingerprint)).not.toContain(fpX);
  });

  // Same finding on two PRs: each CR judges blocking by its own latest occurrence.
  it('同 finding 跨 CR:blocking 判定取本 CR 内最近一次 occurrence', async () => {
    const fpS = semanticFingerprint({ repositoryId: REPO, category: 'correctness', claim: 'shared bug', codeWindow: 'shared()' });
    const s = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fpS, category: 'correctness', canonicalClaim: 'shared bug' });
    await recordOccurrence(db, { tenantId: TENANT, findingId: s.id, revisionId: await newRevision(db, CR_OTHER), state: 'published', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', anchorText: 'shared()', blocking: true, refuterUpheld: true });
    await recordOccurrence(db, { tenantId: TENANT, findingId: s.id, revisionId: await newRevision(db, CR), state: 'published', severity: 'low', changeRelation: 'introduced', confirmation: 'code-supported', anchorText: 'shared()', blocking: false });

    expect((await loadChangeRequestBlockingFindings(db, CR_OTHER)).map((f) => f.fingerprint)).toContain(fpS);
    expect((await loadChangeRequestBlockingFindings(db, CR)).map((f) => f.fingerprint)).not.toContain(fpS);
    expect((await loadActiveFindings(db, REPO, CR)).map((f) => f.fingerprint)).toContain(fpS); // still history on this CR
  });

  // Judged by the latest occurrence, not "any blocking occurrence", or a reverify downgrade would be undone.
  it('同 CR 跨 revision:后一轮降为非 blocking → 退出门禁', async () => {
    const fpD = semanticFingerprint({ repositoryId: REPO, category: 'correctness', claim: 'downgraded', codeWindow: 'dg()' });
    const d = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fpD, category: 'correctness', canonicalClaim: 'downgraded bug' });
    const t0 = Date.now();
    await recordOccurrence(db, { tenantId: TENANT, findingId: d.id, revisionId: await newRevision(db, CR), state: 'published', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', anchorText: 'dg()', blocking: true, refuterUpheld: true, now: t0 });
    expect((await loadChangeRequestBlockingFindings(db, CR)).map((f) => f.fingerprint)).toContain(fpD);

    await recordOccurrence(db, { tenantId: TENANT, findingId: d.id, revisionId: await newRevision(db, CR), state: 'published', severity: 'low', changeRelation: 'introduced', confirmation: 'code-supported', anchorText: 'dg()', blocking: false, now: t0 + 1000 });
    expect((await loadChangeRequestBlockingFindings(db, CR)).map((f) => f.fingerprint)).not.toContain(fpD);
  });

  // Historical blocking items are re-judged by the current gate: no refuter result means no endorsement.
  it('历史阻断按当前标准重判:没有 refuter 背书的退出门禁', async () => {
    const mk = async (claim: string, severity: string, refuterUpheld?: boolean) => {
      const fp = semanticFingerprint({ repositoryId: REPO, category: 'correctness', claim, codeWindow: claim });
      const f = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fp, category: 'correctness', canonicalClaim: claim });
      await recordOccurrence(db, { tenantId: TENANT, findingId: f.id, revisionId: await newRevision(db, CR), state: 'inline', severity, changeRelation: 'introduced', confirmation: 'independently-verified', anchorText: claim, blocking: true, ...(refuterUpheld !== undefined ? { refuterUpheld } : {}) });
      return fp;
    };
    const unbackedMedium = await mk('clock rollback keeps stale entries', 'medium');
    const upheldMedium = await mk('ttl boundary returns stale value', 'medium', true);
    const unbackedHigh = await mk('unbounded growth under load', 'high');
    // A repository that lets medium block.
    const fps = (await loadChangeRequestBlockingFindings(db, CR, { blockOnSeverity: ['critical', 'high', 'medium'] })).map((f) => f.fingerprint);
    expect(fps).not.toContain(unbackedMedium);
    expect(fps).toContain(upheldMedium);
    expect(fps).not.toContain(unbackedHigh);
    // The default leaves medium out: upheld mediums drop out too.
    expect((await loadChangeRequestBlockingFindings(db, CR)).map((f) => f.fingerprint)).not.toContain(upheldMedium);
  });

  // Claim wording comes from the latest occurrence; old rows without one fall back to the canonical claim.
  it('活跃 finding 与门禁项的 claim 取最近一次 occurrence 的措辞', async () => {
    const fp = semanticFingerprint({ repositoryId: REPO, category: 'correctness', claim: 'cache grows', codeWindow: 'cache()' });
    const f = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fp, category: 'correctness', canonicalClaim: 'expired entries are kept on a miss' });
    const t0 = Date.now();
    await recordOccurrence(db, { tenantId: TENANT, findingId: f.id, revisionId: await newRevision(db, CR), state: 'inline', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', anchorText: 'cache()', blocking: true, refuterUpheld: true, now: t0 });
    const claimOf = async () => ({
      active: (await loadActiveFindings(db, REPO, CR)).find((x) => x.fingerprint === fp)?.claim,
      gate: (await loadChangeRequestBlockingFindings(db, CR)).find((x) => x.fingerprint === fp)?.claim,
    });
    expect(await claimOf()).toEqual({ active: 'expired entries are kept on a miss', gate: 'expired entries are kept on a miss' });

    await recordOccurrence(db, { tenantId: TENANT, findingId: f.id, revisionId: await newRevision(db, CR), state: 'inline', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', anchorText: 'cache()', blocking: true, refuterUpheld: true, claim: 'keys that are never read again are never evicted', now: t0 + 1000 });
    expect(await claimOf()).toEqual({ active: 'keys that are never read again are never evicted', gate: 'keys that are never read again are never evicted' });
  });

  it('本 CR 上被 @bot ignore 的 finding 不进门禁(§26.4)', async () => {
    const fpI = semanticFingerprint({ repositoryId: REPO, category: 'correctness', claim: 'ignored', codeWindow: 'ig()' });
    const i = await upsertFinding(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fpI, category: 'correctness', canonicalClaim: 'ignored bug' });
    await recordOccurrence(db, { tenantId: TENANT, findingId: i.id, revisionId: await newRevision(db, CR), state: 'published', severity: 'high', changeRelation: 'introduced', confirmation: 'independently-verified', anchorText: 'ig()', blocking: true, refuterUpheld: true });
    expect((await loadChangeRequestBlockingFindings(db, CR)).map((f) => f.fingerprint)).toContain(fpI);

    await dismissFindingForChangeRequest(db, { tenantId: TENANT, findingId: i.id, changeRequestId: CR, actor: 'someone' });
    expect((await loadChangeRequestBlockingFindings(db, CR)).map((f) => f.fingerprint)).not.toContain(fpI);
  });

  // Fingerprint drifted but identity matching says it is the same finding: reuse the existing row.
  describe('matchedFindingId:复用既有行而不是按漂移的指纹另插一条', () => {
    const base = { tenantId: TENANT, repositoryId: REPO, category: 'correctness' };

    it('指纹不同但给了 matchedFindingId → 不新建,只前移 last_seen_at', async () => {
      const first = await upsertFinding(db, { ...base, fingerprint: 'fp-round-1', canonicalClaim: 'binary resolution skipped' });
      const before = await db.selectFrom('findings').select('last_seen_at').where('id', '=', first.id).executeTakeFirstOrThrow();

      // Second round: reworded claim, new fingerprint, matched to the same finding.
      const second = await upsertFinding(db, {
        ...base,
        fingerprint: 'fp-round-2-drifted',
        canonicalClaim: 'can execute a different tmux binary',
        matchedFindingId: first.id,
        now: Date.now() + 60_000,
      });
      expect(second.isNew).toBe(false);
      expect(second.id).toBe(first.id);
      expect(await db.selectFrom('findings').select('id').where('semantic_fingerprint', '=', 'fp-round-2-drifted').execute()).toHaveLength(0);
      const after = await db.selectFrom('findings').select('last_seen_at').where('id', '=', first.id).executeTakeFirstOrThrow();
      expect(after.last_seen_at.getTime()).toBeGreaterThan(before.last_seen_at.getTime());
    });

    it('指向别的仓库的 id → 忽略,照常新建(它是跨模块传来的字符串,必须校验归属)', async () => {
      const otherRepo = uuidv7();
      await db
        .insertInto('repositories')
        .values({ id: otherRepo, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '10', namespace: 'acme', name: 'other', clone_url: 'x', default_branch: 'main', created_at: new Date() })
        .execute();
      const elsewhere = await upsertFinding(db, { ...base, repositoryId: otherRepo, fingerprint: 'fp-elsewhere', canonicalClaim: 'somewhere else' });
      const r = await upsertFinding(db, { ...base, fingerprint: 'fp-fresh', canonicalClaim: 'fresh one', matchedFindingId: elsewhere.id });
      expect(r.isNew).toBe(true);
      expect(r.id).not.toBe(elsewhere.id);
    });

    it('指向不存在的行 → 不抛错,照常新建(身份判错不该让发布失败)', async () => {
      const r = await upsertFinding(db, { ...base, fingerprint: 'fp-ghost', canonicalClaim: 'ghost', matchedFindingId: uuidv7() });
      expect(r.isNew).toBe(true);
    });

    // Lifecycle is repo-wide but stale evidence comes from one CR, so archiving must not touch these.
    it('在别的 CR 上也出现过的 finding → 标出来(归档侧据此不动它)', async () => {
      const hereRev = await newRevision(db, CR);
      const otherRev = await newRevision(db, CR_OTHER);
      const shared = await upsertFinding(db, { ...base, fingerprint: 'fp-two-crs', canonicalClaim: 'shared across PRs' });
      const onlyHere = await upsertFinding(db, { ...base, fingerprint: 'fp-one-cr', canonicalClaim: 'only this PR' });
      for (const [id, revisionId] of [[shared.id, hereRev], [shared.id, otherRev], [onlyHere.id, hereRev]] as const) {
        await recordOccurrence(db, { tenantId: TENANT, findingId: id, revisionId, state: 'inline', severity: 'medium', changeRelation: 'introduced', confirmation: 'independently-verified' });
      }
      const active = await loadActiveFindings(db, REPO, CR);
      const byId = new Map(active.map((f) => [f.id, f]));
      expect(byId.get(shared.id)?.seenOnOtherChangeRequests).toBe(true);
      expect(byId.get(onlyHere.id)?.seenOnOtherChangeRequests).toBe(false);
    });

    // Stale is an inference and must be reversible; resolved / retracted / dismissed are not.
    it('已归档 stale 的 finding 再次被报出 → 复活回活跃集', async () => {
      const first = await upsertFinding(db, { ...base, fingerprint: 'fp-revive', canonicalClaim: 'flaky guard' });
      await setFindingLifecycle(db, first.id, 'stale');
      const again = await upsertFinding(db, { ...base, fingerprint: 'fp-revive', canonicalClaim: 'flaky guard' });
      expect(again.id).toBe(first.id);
      const row = await db.selectFrom('findings').select('lifecycle').where('id', '=', first.id).executeTakeFirstOrThrow();
      expect(row.lifecycle).toBe('persisted');
    });

    it('resolved / retracted 不因再次被报出而复活(那是有依据的判定)', async () => {
      for (const lc of ['resolved', 'retracted'] as const) {
        const f = await upsertFinding(db, { ...base, fingerprint: `fp-keep-${lc}`, canonicalClaim: `keep ${lc}` });
        await setFindingLifecycle(db, f.id, lc);
        await upsertFinding(db, { ...base, fingerprint: `fp-keep-${lc}`, canonicalClaim: `keep ${lc}` });
        const row = await db.selectFrom('findings').select('lifecycle').where('id', '=', f.id).executeTakeFirstOrThrow();
        expect(row.lifecycle).toBe(lc);
      }
    });
  });
});
