import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import type { ChangeRequestRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import {
  ProviderError,
  type CommentRef,
  type CommentReceipt,
  type DiscussionTarget,
  type DiscussionThread,
  type IdempotencyContext,
  type ProviderAnchor,
  type RichComment,
} from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { publicationMarker, publishInlineComment, publishReviewBatch, publishTopLevelComment, reconcilePublications, topLevelMarker } from '../src/index.js';
import type { PublishContext, PublishInlineInput } from '../src/index.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const CR_ID = uuidv7();

const CR: ChangeRequestRef = { id: CR_ID, repositoryId: uuidv7(), nativeId: '5001', number: 42, kind: 'pull-request' };
const ANCHOR: ProviderAnchor = { path: 'a.ts', side: 'head', line: 10 };

class StubDiscussions {
  comments: { nativeId: string; body: string }[] = [];
  threads: DiscussionThread[] = [];
  fail4xx = false;
  calls = 0;

  createInlineComment = async (
    _ref: ChangeRequestRef,
    _anchor: ProviderAnchor,
    body: RichComment,
    _idem: IdempotencyContext,
  ): Promise<CommentReceipt> => {
    this.calls += 1;
    if (this.fail4xx) throw new ProviderError('http_error', 'unprocessable', { status: 422 });
    const nativeId = `c${this.comments.length + 1}`;
    this.comments.push({ nativeId, body: body.markdown });
    this.threads.push({
      ref: { nativeId },
      resolved: false,
      comments: [{ nativeId, author: { providerUserId: 'bot', login: 'bot', type: 'bot' }, body: body.markdown, createdAt: '', isBot: true }],
    });
    return { nativeId, url: 'u' };
  };

  topLevel: { nativeId: string; body: string; isBot: boolean }[] = [];
  topLevelCreates = 0;
  topLevelEdits = 0;
  createTopLevelComment = async (_target: DiscussionTarget, body: RichComment, _idem: IdempotencyContext): Promise<CommentReceipt> => {
    this.topLevelCreates += 1;
    const nativeId = `tl${this.topLevel.length + 1}`;
    this.topLevel.push({ nativeId, body: body.markdown, isBot: true });
    return { nativeId, url: 'u' };
  };
  editComment = async (comment: CommentRef, body: RichComment): Promise<void> => {
    this.topLevelEdits += 1;
    const c = this.topLevel.find((x) => x.nativeId === comment.nativeId);
    if (c) c.body = body.markdown;
  };
  listTopLevelComments = async (): Promise<{ nativeId: string; body: string; isBot: boolean }[]> =>
    this.topLevel.map((c) => ({ nativeId: c.nativeId, body: c.body, isBot: c.isBot }));

  batchCalls = 0;
  /** 4xx only for batches with inline comments (like GitHub 422 "Line could not be resolved"). */
  failCommentsOnly = false;
  createReviewBatch = async (
    _ref: ChangeRequestRef,
    review: { event: string; summary: RichComment; comments: { anchor: ProviderAnchor; body: RichComment }[] },
    _idem: IdempotencyContext,
  ): Promise<CommentReceipt> => {
    this.batchCalls += 1;
    if (this.fail4xx) throw new ProviderError('http_error', 'unprocessable', { status: 422 });
    if (this.failCommentsOnly && review.comments.length > 0) throw new ProviderError('http_error', 'line could not be resolved', { status: 422 });
    const nativeId = `r${this.batchCalls}`;
    this.comments.push({ nativeId, body: `${review.event}:${JSON.stringify(review.summary)}` });
    // Like the real provider: each inline comment becomes a listable thread comment with its own
    // nativeId while the receipt has only the review id; backfill claims them by listing threads.
    for (const c of review.comments) {
      const commentNativeId = `rc${this.threads.length + 1}`;
      this.threads.push({
        ref: { nativeId: commentNativeId },
        resolved: false,
        anchor: c.anchor,
        comments: [{ nativeId: commentNativeId, author: { providerUserId: 'bot', login: 'bot', type: 'bot' }, body: c.body.markdown, createdAt: '', isBot: true }],
      });
    }
    return { nativeId, url: 'u' };
  };

  listThreads = async (_target: DiscussionTarget): Promise<DiscussionThread[]> => this.threads;
}

describe('publisher', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let discussions: StubDiscussions;
  let currentHead = 'head-1';

  const input = (findingId: string, revisionId: string, expectedHeadSha = 'head-1'): PublishInlineInput => ({
    tenantId: TENANT,
    repositoryId: CR.repositoryId,
    changeRequest: CR,
    changeRequestId: CR_ID,
    revisionId,
    revisionSha: 'head-1',
    providerHostId: HOST,
    findingId,
    anchor: ANCHOR,
    bodyMarkdown: 'This is a finding.',
    expectedHeadSha,
  });

  const ctx = (): PublishContext => ({ db, discussions, fetchCurrentHeadSha: async () => currentHead });

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
  });

  beforeEach(() => {
    discussions = new StubDiscussions();
    currentHead = 'head-1';
  });

  afterAll(async () => {
    await stop?.();
  });

  it('首次发布:pending→published,body 含隐藏标记', async () => {
    const f = uuidv7();
    const rv = uuidv7();
    const r = await publishInlineComment(ctx(), input(f, rv));
    expect(r.status).toBe('published');
    expect(discussions.calls).toBe(1);
    expect(discussions.comments[0]!.body).toContain(`winnowl:finding=${f}`);
    const rec = await db.selectFrom('publication_records').selectAll().where('finding_id', '=', f).executeTakeFirstOrThrow();
    expect(rec.state).toBe('published');
    expect(rec.provider_native_id).toBe('c1');
  });

  it('相同幂等键重复发布 → duplicate,不再调 Provider', async () => {
    const f = uuidv7();
    const rv = uuidv7();
    await publishInlineComment(ctx(), input(f, rv));
    const r = await publishInlineComment(ctx(), input(f, rv));
    expect(r.status).toBe('duplicate');
    expect(discussions.calls).toBe(1);
  });

  it('HEAD 变化 → superseded,不发布', async () => {
    currentHead = 'head-2';
    const r = await publishInlineComment(ctx(), input(uuidv7(), uuidv7(), 'head-1'));
    expect(r.status).toBe('superseded');
    expect(discussions.calls).toBe(0);
  });

  it('Provider 4xx → degraded,记录 failed', async () => {
    discussions.fail4xx = true;
    const f = uuidv7();
    const r = await publishInlineComment(ctx(), input(f, uuidv7()));
    expect(r.status).toBe('degraded');
    const rec = await db.selectFrom('publication_records').selectAll().where('finding_id', '=', f).executeTakeFirstOrThrow();
    expect(rec.state).toBe('failed');
  });

  it('崩溃重试:既有 pending + 标记已发布 → 对账为 published,不重复发', async () => {
    const pubId = uuidv7();
    const f = uuidv7();
    const rv = uuidv7();
    await db.insertInto('publication_records').values({
      id: pubId, tenant_id: TENANT, repository_id: CR.repositoryId, change_request_id: CR_ID,
      finding_id: f, revision_id: rv, provider_host_id: HOST, kind: 'inline',
      idempotency_key: `inline:${f}:${rv}`, provider_native_id: null, provider_url: null,
      state: 'pending', request_digest: 'x', response: null, created_at: new Date(), updated_at: new Date(),
    }).execute();
    // The provider already has the comment (with marker).
    discussions.threads.push({
      ref: { nativeId: 'cX' }, resolved: false,
      comments: [{ nativeId: 'cX', author: { providerUserId: 'bot', login: 'bot', type: 'bot' }, body: `finding\n\n${publicationMarker({ findingId: f, revision: 'head-1', publicationId: pubId })}`, createdAt: '', isBot: true }],
    });

    const r = await publishInlineComment(ctx(), input(f, rv));
    expect(r.status).toBe('published');
    expect((r as { recovered?: boolean }).recovered).toBe(true);
    expect(discussions.calls).toBe(0);
  });

  it('reconcilePublications:据标记补全 pending', async () => {
    const pubId = uuidv7();
    const f = uuidv7();
    const rv = uuidv7();
    await db.insertInto('publication_records').values({
      id: pubId, tenant_id: TENANT, repository_id: CR.repositoryId, change_request_id: CR_ID,
      finding_id: f, revision_id: rv, provider_host_id: HOST, kind: 'inline',
      idempotency_key: `inline:${f}:${rv}`, provider_native_id: null, provider_url: null,
      state: 'pending', request_digest: 'x', response: null, created_at: new Date(), updated_at: new Date(),
    }).execute();
    discussions.threads.push({
      ref: { nativeId: 'cY' }, resolved: false,
      comments: [{ nativeId: 'cY', author: { providerUserId: 'bot', login: 'bot', type: 'bot' }, body: publicationMarker({ findingId: f, revision: 'head-1', publicationId: pubId }), createdAt: '', isBot: true }],
    });

    const r = await reconcilePublications(ctx(), { changeRequest: CR, providerHostId: HOST, changeRequestId: CR_ID });
    expect(r.recovered).toBe(1);
    const rec = await db.selectFrom('publication_records').selectAll().where('id', '=', pubId).executeTakeFirstOrThrow();
    expect(rec.state).toBe('published');
    expect(rec.provider_native_id).toBe('cY');
  });

  const batchInput = (rv: string) => ({
    tenantId: TENANT,
    repositoryId: CR.repositoryId,
    changeRequest: CR,
    changeRequestId: CR_ID,
    revisionId: rv,
    revisionSha: 'head-1',
    providerHostId: HOST,
    event: 'comment' as const,
    summaryMarkdown: 'Review summary.',
    comments: [{ findingId: uuidv7(), anchor: ANCHOR, bodyMarkdown: 'inline.' }],
    expectedHeadSha: 'head-1',
  });

  it('review 批量:首次 published', async () => {
    const r = await publishReviewBatch(ctx(), batchInput(uuidv7()));
    expect(r.status).toBe('published');
    expect(discussions.batchCalls).toBe(1);
  });

  it('review 批量:回填每条 inline 的 finding ↔ 评论映射(2026-07-31 live 缺陷)', async () => {
    const rv = uuidv7();
    const f1 = uuidv7();
    const f2 = uuidv7();
    const r = await publishReviewBatch(ctx(), {
      tenantId: TENANT,
      repositoryId: CR.repositoryId,
      changeRequest: CR,
      changeRequestId: CR_ID,
      revisionId: rv,
      revisionSha: 'head-1',
      providerHostId: HOST,
      event: 'comment',
      summaryMarkdown: 'summary.',
      comments: [
        { findingId: f1, anchor: ANCHOR, bodyMarkdown: 'first.' },
        { findingId: f2, anchor: { path: 'b.ts', side: 'head', line: 20 }, bodyMarkdown: 'second.' },
      ],
      expectedHeadSha: 'head-1',
    });
    expect(r.status).toBe('published');
    // One row per inline comment with finding_id + its nativeId; replies look findings up by it.
    const rows = await db.selectFrom('publication_records').selectAll().where('revision_id', '=', rv).where('kind', '=', 'inline').execute();
    expect(rows).toHaveLength(2);
    expect(rows.map((x) => x.finding_id).sort()).toEqual([f1, f2].sort());
    for (const row of rows) {
      expect(row.state).toBe('published');
      expect(row.provider_native_id).toMatch(/^rc\d+$/); // a comment id, not the review id
    }
    // The summary (findingId 'review') gets no inline row.
    expect(rows.some((x) => x.finding_id === null)).toBe(false);
  });

  it('review 批量 4xx → degraded + failed,response 记录现场(status/message)', async () => {
    discussions.fail4xx = true;
    const rv = uuidv7();
    const r = await publishReviewBatch(ctx(), batchInput(rv));
    expect(r.status).toBe('degraded');
    const rec = await db.selectFrom('publication_records').selectAll().where('revision_id', '=', rv).where('kind', '=', 'review').executeTakeFirstOrThrow();
    expect(rec.state).toBe('failed');
    expect((rec.response as { status?: number }).status).toBe(422);
  });

  it('review 批量 inline 锚点被拒(422)→ 剥离评论重试只发 summary/event,published + 降级现场(2026-07-21 conduit#148)', async () => {
    discussions.failCommentsOnly = true;
    const rv = uuidv7();
    const r = await publishReviewBatch(ctx(), batchInput(rv));
    expect(r.status).toBe('published');
    expect((r as { publishedComments?: number }).publishedComments).toBe(0);
    expect(discussions.batchCalls).toBe(2);
    const rec = await db.selectFrom('publication_records').selectAll().where('revision_id', '=', rv).where('kind', '=', 'review').executeTakeFirstOrThrow();
    expect(rec.state).toBe('published');
    expect((rec.response as { degraded?: string; status?: number }).degraded).toBe('comments_dropped');
    expect((rec.response as { status?: number }).status).toBe(422);
  });

  it('failed 的 review 重跑 → 复位 pending 并重发(2026-07-19 回归:此前 failed 被当 pending 永不重试)', async () => {
    const rv = uuidv7();
    discussions.fail4xx = true;
    expect((await publishReviewBatch(ctx(), batchInput(rv))).status).toBe('degraded');
    discussions.fail4xx = false;
    const r = await publishReviewBatch(ctx(), batchInput(rv));
    expect(r.status).toBe('published');
    const rec = await db.selectFrom('publication_records').selectAll().where('revision_id', '=', rv).where('kind', '=', 'review').executeTakeFirstOrThrow();
    expect(rec.state).toBe('published');
  });

  it('pending 的 review 重跑 → 保守不重发(pending_no_retry;可能上次已发出)', async () => {
    const rv = uuidv7();
    await db.insertInto('publication_records').values({
      id: uuidv7(), tenant_id: TENANT, repository_id: CR.repositoryId, change_request_id: CR_ID,
      finding_id: null, revision_id: rv, provider_host_id: HOST, kind: 'review',
      idempotency_key: `review:${rv}`, provider_native_id: null, provider_url: null,
      state: 'pending', request_digest: 'x', response: null, created_at: new Date(), updated_at: new Date(),
    }).execute();
    const r = await publishReviewBatch(ctx(), batchInput(rv));
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('pending_no_retry');
    expect(discussions.batchCalls).toBe(0);
  });

  const topInput = (crId: string, extra: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    repositoryId: CR.repositoryId,
    changeRequest: { ...CR, id: crId },
    changeRequestId: crId,
    providerHostId: HOST,
    kind: 'ci-analysis' as const,
    bodyMarkdown: 'CI 根因分析 v1',
    fingerprint: 'fp-1',
    ...extra,
  });

  it('顶层评论首发 → 新建一条(带 marker),状态 published/created', async () => {
    const crId = uuidv7();
    const r = await publishTopLevelComment(ctx(), topInput(crId));
    expect(r.status).toBe('published');
    expect(discussions.topLevelCreates).toBe(1);
    expect(discussions.topLevel[0].body).toContain(topLevelMarker('ci-analysis', crId));
  });

  it('同 kind 新 head 内容变 → edit 同一条(不新建),仍 1 条评论', async () => {
    const crId = uuidv7();
    await publishTopLevelComment(ctx(), topInput(crId));
    const r = await publishTopLevelComment(ctx(), topInput(crId, { bodyMarkdown: 'CI 根因分析 v2', fingerprint: 'fp-2' }));
    expect(r.status).toBe('published');
    expect(r.created).toBe(false);
    expect(discussions.topLevelCreates).toBe(1);
    expect(discussions.topLevelEdits).toBe(1);
    expect(discussions.topLevel).toHaveLength(1);
    expect(discussions.topLevel[0].body).toContain('v2');
  });

  it('根因指纹未变 → 跳过(unchanged,不 edit)', async () => {
    const crId = uuidv7();
    await publishTopLevelComment(ctx(), topInput(crId));
    const r = await publishTopLevelComment(ctx(), topInput(crId, { bodyMarkdown: '正文措辞小变但根因同' }));
    expect(r.status).toBe('unchanged');
    expect(discussions.topLevelEdits).toBe(0);
    expect(discussions.topLevel).toHaveLength(1);
  });

  it('DB 记录丢失但评论带 marker → 经 list 找回并 edit(不新建重复)', async () => {
    const crId = uuidv7();
    await publishTopLevelComment(ctx(), topInput(crId));
    await db.deleteFrom('publication_records').where('change_request_id', '=', crId).where('kind', '=', 'ci-analysis').execute();
    const r = await publishTopLevelComment(ctx(), topInput(crId, { fingerprint: 'fp-new' }));
    expect(r.created).toBe(false);
    expect(discussions.topLevelCreates).toBe(1);
    expect(discussions.topLevel).toHaveLength(1);
  });
});
