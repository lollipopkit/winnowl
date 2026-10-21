import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '@reviewbot/config';
import { createDb, sql, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const TENANT = uuidv7();
const OTHER_TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();
const FINDING = uuidv7();
const FINDING2 = uuidv7();
const POOL = uuidv7();
const WORKER = uuidv7();

describe('control-api Web Console 数据端点', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;

    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('tenants')
      .values({ id: OTHER_TENANT, name: 'other', region: null, created_at: new Date() })
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
        head_sha: 'head1',
        merge_base_sha: null,
        source_branch: 'feat',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('findings')
      .values({
        id: FINDING,
        tenant_id: TENANT,
        repository_id: REPO,
        semantic_fingerprint: 'fp1',
        category: 'correctness',
        canonical_claim: 'off-by-one in add',
        lifecycle: 'new',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    await db
      .insertInto('finding_occurrences')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        finding_id: FINDING,
        review_run_id: null,
        revision_id: REV,
        state: 'inline',
        severity: 'high',
        change_relation: 'introduced',
        confirmation: 'independently-verified',
        anchor: JSON.stringify({ path: 'app.py', line: 2 }) as unknown as Record<string, unknown>,
        evidence: JSON.stringify([{ kind: 'code', ref: 'app.py:2' }]) as unknown as unknown[],
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('publication_records')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        repository_id: REPO,
        change_request_id: CR,
        finding_id: FINDING,
        revision_id: REV,
        provider_host_id: HOST,
        kind: 'inline-comment',
        idempotency_key: 'k1',
        provider_native_id: 'c1',
        provider_url: 'https://github.com/acme/app/pull/42#c1',
        state: 'published',
        request_digest: 'd',
        response: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    // Suppressed finding
    await db
      .insertInto('findings')
      .values({
        id: FINDING2,
        tenant_id: TENANT,
        repository_id: REPO,
        semantic_fingerprint: 'fp2',
        category: 'style',
        canonical_claim: 'noisy nit',
        lifecycle: 'new',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    await db
      .insertInto('finding_occurrences')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        finding_id: FINDING2,
        review_run_id: null,
        revision_id: REV,
        state: 'suppressed',
        severity: 'low',
        change_relation: 'preexisting-unrelated',
        confirmation: 'code-supported',
        anchor: null,
        evidence: JSON.stringify([]) as unknown as unknown[],
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('repository_settings')
      .values({
        repository_id: REPO,
        tenant_id: TENANT,
        settings: JSON.stringify({ merge_gate: { enabled: false } }) as unknown as Record<
          string,
          unknown
        >,
        config_digest: 'cfg-abc',
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('runner_pools')
      .values({ id: POOL, tenant_id: TENANT, name: 'default', created_at: new Date() })
      .execute();
    await db
      .insertInto('workers')
      .values({
        id: WORKER,
        pool_id: POOL,
        mode: 'active',
        version: '1.0.0',
        capabilities: JSON.stringify({}) as unknown as Record<string, unknown>,
        max_concurrency: 2,
        running_jobs: 0,
        last_heartbeat_at: new Date(),
        registered_at: new Date(),
      })
      .execute();
    await db
      .insertInto('review_costs')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        repository_id: REPO,
        change_request_id: CR,
        revision_id: REV,
        input_tokens: 1000,
        output_tokens: 250,
        total_tokens: 1250,
        cost_usd: 0.05,
        candidate_count: 3,
        published_inline: 1,
        scopes_total: 4,
        scopes_complete: 3,
        created_at: new Date(),
      })
      .execute();

    app = await buildServer({
      quiet: true,
      db,
      rbac: { resolveAuth: () => ({ role: 'admin', scopes: ['admin'], tenantId: TENANT }) },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await stop?.();
  });

  it('GET /v1/reviews 列出 review run(含 finding/published 计数)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/reviews' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    // REV has 2 occurrences: one verified and posted inline, one suppressed.
    expect(body.items[0]).toMatchObject({
      revisionId: REV,
      verified: 1,
      published: 1,
      topSeverity: 'high',
      repository: 'acme/app',
      state: 'pending',
    });
  });

  it('review 子记录和计数显式按 tenant 隔离', async () => {
    const foreignFindingId = uuidv7();
    const occurrenceId = uuidv7();
    const publicationId = uuidv7();
    await db
      .insertInto('findings')
      .values({
        id: foreignFindingId,
        tenant_id: OTHER_TENANT,
        repository_id: REPO,
        semantic_fingerprint: `foreign-${foreignFindingId}`,
        category: 'security',
        canonical_claim: 'foreign tenant finding',
        lifecycle: 'new',
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    await db
      .insertInto('finding_occurrences')
      .values({
        id: occurrenceId,
        tenant_id: OTHER_TENANT,
        finding_id: foreignFindingId,
        review_run_id: null,
        revision_id: REV,
        state: 'inline',
        severity: 'critical',
        change_relation: 'introduced',
        confirmation: 'independently-verified',
        anchor: { path: 'secret.ts' },
        evidence: JSON.stringify([{ kind: 'code', ref: 'secret.ts:1' }]),
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('publication_records')
      .values({
        id: publicationId,
        tenant_id: OTHER_TENANT,
        repository_id: REPO,
        change_request_id: CR,
        finding_id: foreignFindingId,
        revision_id: REV,
        provider_host_id: HOST,
        kind: 'inline-comment',
        idempotency_key: `cross-${publicationId}`,
        provider_native_id: 'foreign',
        provider_url: 'https://example.invalid/foreign',
        state: 'published',
        request_digest: 'd',
        response: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    try {
      const list = (await app.inject({ method: 'GET', url: '/v1/reviews' })).json();
      expect(list.items[0]).toMatchObject({ verified: 1, published: 1, topSeverity: 'high' });
      const detail = (await app.inject({ method: 'GET', url: `/v1/reviews/${REV}` })).json();
      expect(detail.findings).toHaveLength(1);
      expect(detail.suppressed).toHaveLength(1);
      expect(detail.publications).toHaveLength(1);
      expect(detail.publications[0]?.providerUrl).not.toContain('example.invalid');
    } finally {
      await db.deleteFrom('publication_records').where('id', '=', publicationId).execute();
      await db.deleteFrom('finding_occurrences').where('id', '=', occurrenceId).execute();
      await db.deleteFrom('findings').where('id', '=', foreignFindingId).execute();
    }
  });

  it('GET /v1/reviews/progress 返回步骤下标,**内部阶段名不出响应**', async () => {
    const JOB = uuidv7();
    await db
      .insertInto('jobs')
      .values({
        id: JOB,
        tenant_id: TENANT,
        type: 'review_revision',
        status: 'running',
        payload: JSON.stringify({}) as unknown as Record<string, unknown>,
        runner_selector: JSON.stringify({}) as unknown as Record<string, unknown>,
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('review_progress')
      .values({
        job_id: JOB,
        tenant_id: TENANT,
        repository_id: REPO,
        change_request_id: CR,
        revision_id: REV,
        stage: 'dig',
        done: 4,
        total: 13,
        attempt: 2,
        started_at: new Date(Date.now() - 60_000),
        updated_at: new Date(),
        finished_at: null,
      })
      .execute();

    const res = await app.inject({ method: 'GET', url: '/v1/reviews/progress' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    // The internal stage name (dig) becomes a step index and count kind; it never appears in the response.
    expect(body.items[0]).toMatchObject({
      jobId: JOB,
      stepIndex: 2,
      stepCount: 6,
      countKind: 'areas',
      outcome: null,
      done: 4,
      total: 13,
      attempt: 2,
      repository: 'acme/app',
      changeNumber: 42,
      sourceBranch: 'feat',
      targetBranch: 'main',
    });
    expect(JSON.stringify(body)).not.toContain('dig');
    // No tenant name in the tenant view.
    expect(body.items[0]!.tenantName).toBeUndefined();

    // Finished runs stay listed briefly with finishedAt.
    await db
      .updateTable('review_progress')
      .set({ stage: 'done', finished_at: new Date() })
      .where('job_id', '=', JOB)
      .execute();
    const after = (await app.inject({ method: 'GET', url: '/v1/reviews/progress' })).json() as {
      items: { outcome: string; stepIndex: number | null; finishedAt: string | null }[];
    };
    expect(after.items[0]).toMatchObject({ outcome: 'done', stepIndex: null });
    expect(after.items[0]!.finishedAt).not.toBeNull();

    await db.deleteFrom('review_progress').where('job_id', '=', JOB).execute();
    await db.deleteFrom('jobs').where('id', '=', JOB).execute();
  });

  // Manual stop sets cancellation_requested; a finished run -> 404.
  it('POST /v1/reviews/progress/:jobId/cancel → 置取消位;已结束/不存在 → 404', async () => {
    const JOB = uuidv7();
    await db
      .insertInto('jobs')
      .values({
        id: JOB,
        tenant_id: TENANT,
        type: 'review_revision',
        status: 'running',
        payload: JSON.stringify({}) as unknown as Record<string, unknown>,
        runner_selector: JSON.stringify({}) as unknown as Record<string, unknown>,
        created_at: new Date(),
      })
      .execute();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/reviews/progress/${JOB}/cancel`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(
      (
        await db
          .selectFrom('jobs')
          .select('cancellation_requested')
          .where('id', '=', JOB)
          .executeTakeFirstOrThrow()
      ).cancellation_requested,
    ).toBe(true);

    await db.updateTable('jobs').set({ status: 'completed' }).where('id', '=', JOB).execute();
    const again = await app.inject({
      method: 'POST',
      url: `/v1/reviews/progress/${JOB}/cancel`,
      payload: {},
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ error: 'review_not_running' });

    // Unknown ids and other tenants' jobs return the same 404.
    const missing = await app.inject({
      method: 'POST',
      url: `/v1/reviews/progress/${uuidv7()}/cancel`,
      payload: {},
    });
    expect(missing.statusCode).toBe(404);

    await db.deleteFrom('jobs').where('id', '=', JOB).execute();
  });

  it('GET /v1/reviews/progress?all=1 非运维 → 403(租户 owner 也不该看见别人的仓库名)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/reviews/progress?all=1' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'operator_only' });
  });

  it('GET /v1/reviews/:id 回答 §40 问题(claim/证据/anchor/publication)', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/reviews/${REV}` });
    expect(res.statusCode).toBe(200);
    const detail = res.json();
    expect(detail.run.headSha).toBe('head1');
    expect(detail.findings[0]).toMatchObject({ claim: 'off-by-one in add', confirmation: 'independently-verified', path: 'app.py', line: 2 });
    expect(detail.suppressed[0]).toMatchObject({ claim: 'noisy nit' });
    expect(detail.publications[0]!.providerUrl).toContain('pull/42');
  });

  it('未知 revision → 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/reviews/${uuidv7()}` });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/findings 列出 finding(含出现次数与严重度)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/findings' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { id: string; claim: string; occurrenceCount: number; severity: string }[];
      total: number;
    };
    expect(body.items.find((f) => f.id === FINDING)?.occurrenceCount).toBe(1);
    // Severity lives on finding_occurrences, not findings.
    expect(body.items.find((f) => f.id === FINDING)?.severity).toBe('high');
    expect(body.items.find((f) => f.id === FINDING2)?.severity).toBe('low');
  });

  it('GET /v1/findings?severity= 筛选;一条 finding 的严重度取各次里**最重**的那个', async () => {
    // Cleans up its own data: the tests share a fixture and an extra revision breaks other assertions.
    const REV2 = uuidv7();
    const OCC2 = uuidv7();
    await db
      .insertInto('revisions')
      .values({
        id: REV2,
        tenant_id: TENANT,
        change_request_id: CR,
        base_sha: 'base',
        head_sha: 'head2',
        merge_base_sha: null,
        source_branch: 'feat',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    // One occurrence per finding per revision (unique), so re-rating needs a later revision.
    await db
      .insertInto('finding_occurrences')
      .values({
        id: OCC2,
        tenant_id: TENANT,
        finding_id: FINDING2,
        review_run_id: null,
        revision_id: REV2,
        state: 'inline',
        severity: 'critical',
        change_relation: 'introduced',
        confirmation: 'code-supported',
        anchor: null,
        evidence: JSON.stringify([]) as unknown as unknown[],
        created_at: new Date(),
      })
      .execute();

    try {
      const all = (await app.inject({ method: 'GET', url: '/v1/findings' })).json() as {
        items: { id: string; severity: string }[];
      };
      // Most severe, not latest: a later low rating must not hide a once-critical finding.
      expect(all.items.find((f) => f.id === FINDING2)?.severity).toBe('critical');

      // Filter matches any occurrence, so FINDING2 matches both low and critical.
      const crit = (
        await app.inject({ method: 'GET', url: '/v1/findings?severity=critical' })
      ).json() as { items: { id: string }[] };
      expect(crit.items.map((f) => f.id)).toEqual([FINDING2]);
      const low = (
        await app.inject({ method: 'GET', url: '/v1/findings?severity=low' })
      ).json() as { items: { id: string }[] };
      expect(low.items.map((f) => f.id)).toEqual([FINDING2]);
      const high = (
        await app.inject({ method: 'GET', url: '/v1/findings?severity=high' })
      ).json() as { items: { id: string }[] };
      expect(high.items.map((f) => f.id)).toEqual([FINDING]);

      const sorted = (
        await app.inject({ method: 'GET', url: '/v1/findings?sort=severity&dir=asc' })
      ).json() as { items: { id: string }[] };
      expect(sorted.items[0]!.id).toBe(FINDING2);
    } finally {
      await db.deleteFrom('finding_occurrences').where('id', '=', OCC2).execute();
      await db.deleteFrom('revisions').where('id', '=', REV2).execute();
    }
  });

  it('GET /v1/findings/:id 返回跨 revision 出现', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/findings/${FINDING}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claim).toBe('off-by-one in add');
    expect(body.occurrence).toMatchObject({ confirmation: 'independently-verified', path: 'app.py', line: 2, changeNumber: 42 });
    expect(body.occurrence.evidence).toHaveLength(1);
    expect(body.history).toHaveLength(1);
  });

  it('finding 子记录即使历史数据 tenant 不一致也不会串入列表、详情或 suppressed', async () => {
    const revisionId = uuidv7();
    const occurrenceId = uuidv7();
    // Constraints block new mismatches; disable FK triggers in this fixture transaction to emulate a
    // malformed historical row left in place by a NOT VALID constraint.
    await db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await trx
        .insertInto('revisions')
        .values({
          id: revisionId,
          tenant_id: OTHER_TENANT,
          change_request_id: CR,
          base_sha: 'foreign-base',
          head_sha: `foreign-${revisionId}`,
          merge_base_sha: null,
          source_branch: 'foreign',
          target_branch: 'main',
          created_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('finding_occurrences')
        .values({
          id: occurrenceId,
          tenant_id: OTHER_TENANT,
          finding_id: FINDING,
          review_run_id: null,
          revision_id: revisionId,
          state: 'suppressed',
          severity: 'critical',
          change_relation: 'introduced',
          confirmation: 'independently-verified',
          anchor: { path: 'foreign.ts' },
          evidence: JSON.stringify([]) as unknown as unknown[],
          created_at: new Date(),
        })
        .execute();
    });
    try {
      const list = (await app.inject({ method: 'GET', url: '/v1/findings' })).json() as {
        items: { id: string; occurrenceCount: number; severity: string }[];
      };
      expect(list.items.find((finding) => finding.id === FINDING)).toMatchObject({
        occurrenceCount: 1,
        severity: 'high',
      });
      const detail = (await app.inject({ method: 'GET', url: `/v1/findings/${FINDING}` })).json() as {
        history: { revisionId: string }[];
      };
      expect(detail.history.some((occurrence) => occurrence.revisionId === revisionId)).toBe(false);
      const suppressed = (await app.inject({ method: 'GET', url: '/v1/suppressed' })).json() as {
        items: { revisionId: string }[];
      };
      expect(suppressed.items.some((occurrence) => occurrence.revisionId === revisionId)).toBe(
        false,
      );
    } finally {
      await db.deleteFrom('finding_occurrences').where('id', '=', occurrenceId).execute();
      await db.deleteFrom('revisions').where('id', '=', revisionId).execute();
    }
  });

  it('GET /v1/suppressed 仅列被压制项', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/suppressed' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { findingId: string; claim: string }[]; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ findingId: FINDING2, claim: 'noisy nit' });
  });

  const items = (res: { json: () => unknown }): unknown[] =>
    (res.json() as { items: unknown[] }).items;
  const total = (res: { json: () => unknown }): number => (res.json() as { total: number }).total;

  it('reviews filter by status and repositoryId', async () => {
    expect(items(await app.inject({ method: 'GET', url: '/v1/reviews?status=blocked' }))).toHaveLength(0);
    expect(items(await app.inject({ method: 'GET', url: '/v1/reviews?status=running' }))).toHaveLength(0);
    expect(items(await app.inject({ method: 'GET', url: '/v1/reviews?status=failed' }))).toHaveLength(0);
    expect(
      items(await app.inject({ method: 'GET', url: `/v1/reviews?repositoryId=${REPO}` })),
    ).toHaveLength(1);
    expect(
      items(await app.inject({ method: 'GET', url: `/v1/reviews?repositoryId=${uuidv7()}` })),
    ).toHaveLength(0);
  });

  it('reviews 分页 limit/offset(total 不受影响)', async () => {
    const page1 = await app.inject({ method: 'GET', url: '/v1/reviews?limit=1&offset=0' });
    expect(items(page1)).toHaveLength(1);
    expect(total(page1)).toBe(1);
    const page2 = await app.inject({ method: 'GET', url: '/v1/reviews?limit=1&offset=1' });
    expect(items(page2)).toHaveLength(0);
    expect(total(page2)).toBe(1);
  });

  it('repositories 按命名空间/名称搜索', async () => {
    expect(items(await app.inject({ method: 'GET', url: '/v1/repositories?q=acme' }))).toHaveLength(
      1,
    );
    expect(items(await app.inject({ method: 'GET', url: '/v1/repositories?q=APP' }))).toHaveLength(
      1,
    ); // ilike is case-insensitive
    expect(items(await app.inject({ method: 'GET', url: '/v1/repositories?q=zzz' }))).toHaveLength(
      0,
    );
  });

  it('repositories 带配置摘要(来源/预设/合并检查/近 30 天评审)', async () => {
    const repo = items(await app.inject({ method: 'GET', url: '/v1/repositories?q=acme' }))[0] as Record<string, unknown>;
    expect(repo).toMatchObject({ forge: 'github', configSource: 'panel', profile: 'balanced', mergeGate: false, reviews30d: 1 });
    expect(repo.lastReviewAt).toEqual(expect.any(String));
  });

  it('POST /v1/repositories/:id/config/preview 按最近一次评审估算,非法配置 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${REPO}/config/preview`,
      payload: { merge_gate: { enabled: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ basis: { revisionId: REV, candidates: 3 }, gate: expect.any(String) });
    const bad = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${REPO}/config/preview`,
      payload: { reviews: { profile: 'nope' } },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('installations 按状态筛选 + 账号搜索', async () => {
    expect(
      items(await app.inject({ method: 'GET', url: '/v1/installations?status=active' })),
    ).toHaveLength(1);
    expect(
      items(await app.inject({ method: 'GET', url: '/v1/installations?status=suspended' })),
    ).toHaveLength(0);
    expect(
      items(await app.inject({ method: 'GET', url: '/v1/installations?q=acme' })),
    ).toHaveLength(1);
    expect(
      items(await app.inject({ method: 'GET', url: '/v1/installations?q=nope' })),
    ).toHaveLength(0);
  });

  it('findings filter by status, repository and claim; suppressed by repository', async () => {
    expect(items(await app.inject({ method: 'GET', url: '/v1/findings?status=open' }))).toHaveLength(2);
    expect(items(await app.inject({ method: 'GET', url: '/v1/findings?status=resolved' }))).toHaveLength(0);
    expect(items(await app.inject({ method: 'GET', url: `/v1/findings?repositoryId=${uuidv7()}` }))).toHaveLength(0);
    expect(items(await app.inject({ method: 'GET', url: '/v1/findings?q=off-by-one' }))).toHaveLength(1);
    expect(items(await app.inject({ method: 'GET', url: `/v1/suppressed?repositoryId=${REPO}` }))).toHaveLength(1);
    expect(items(await app.inject({ method: 'GET', url: `/v1/suppressed?repositoryId=${uuidv7()}` }))).toHaveLength(0);
  });

  it('sort 白名单外的值被忽略(不 500,回退默认)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/reviews?sort=%27;drop%20table&dir=up',
    });
    expect(res.statusCode).toBe(200);
    expect(items(res)).toHaveLength(1);
  });

  it('GET /v1/repositories/:id/config 返回配置层', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/repositories/${REPO}/config` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      configDigest: string;
      settings: { merge_gate: { enabled: boolean } };
    };
    expect(body.configDigest).toBe('cfg-abc');
    expect(body.settings.merge_gate.enabled).toBe(false);
  });

  it('**从未配置过的仓库 → 200 默认配置**(组织默认值叠在内置默认值上),而不是 404(404 只该表示「没这个仓库」)', async () => {
    // A never-reviewed repository has no repository_settings row; must not 404.
    const fresh = uuidv7();
    await db
      .insertInto('repositories')
      .values({
        id: fresh,
        tenant_id: TENANT,
        provider_host_id: HOST,
        installation_id: INSTALL,
        native_id: '9001',
        namespace: 'acme',
        name: 'never-reviewed',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/repositories/${fresh}/config` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        repositoryId: string;
        settings: Record<string, unknown>;
        configDigest: string | null;
        source: string;
      };
      expect(body.repositoryId).toBe(fresh);
      expect(body.settings).toEqual(defaultConfig());
      expect(body.configDigest).toBeNull();
      expect(body.source).toBe('panel');
    } finally {
      await db.deleteFrom('repositories').where('id', '=', fresh).execute();
    }
  });

  it('不存在的仓库 / 跨租户仓库 → 仍然 404', async () => {
    expect(
      (await app.inject({ method: 'GET', url: `/v1/repositories/${uuidv7()}/config` })).statusCode,
    ).toBe(404);
  });

  it('PUT /v1/repositories/:id/config 校验并 upsert(§40)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/repositories/${REPO}/config`,
      payload: { version: 1, language: 'zh', reviews: { profile: 'thorough' } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
    const row = await db
      .selectFrom('repository_settings')
      .select(['settings', 'panel_settings'])
      .where('repository_id', '=', REPO)
      .executeTakeFirstOrThrow();
    expect((row.settings as { language: string }).language).toBe('zh'); // effective config is complete
    // panel_settings stores only the diff, so later schema default changes still apply.
    expect(row.panel_settings).toEqual({ language: 'zh', reviews: { profile: 'thorough' } });
  });

  it('PUT config 非法值 → 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/repositories/${REPO}/config`,
      payload: { reviews: { profile: 'not-a-real-profile' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT config 拒绝覆盖 repo-file 权威配置', async () => {
    await db
      .updateTable('repository_settings')
      .set({ source: 'repo-file' })
      .where('repository_id', '=', REPO)
      .execute();
    try {
      const before = await db
        .selectFrom('repository_settings')
        .select(['settings', 'config_digest'])
        .where('repository_id', '=', REPO)
        .executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/repositories/${REPO}/config`,
        payload: { version: 1, language: 'fr' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'repository_config_read_only' });
      const after = await db
        .selectFrom('repository_settings')
        .select(['settings', 'config_digest', 'source'])
        .where('repository_id', '=', REPO)
        .executeTakeFirstOrThrow();
      expect(after).toMatchObject({
        settings: before.settings,
        config_digest: before.config_digest,
        source: 'repo-file',
      });
    } finally {
      await db
        .updateTable('repository_settings')
        .set({ source: 'panel' })
        .where('repository_id', '=', REPO)
        .execute();
    }
  });

  it('PUT config 跨租户仓库 → 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/repositories/${uuidv7()}/config`,
      payload: { version: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /v1/repositories/:id/security-scan 入队 security_scan(§35)', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/repositories/${REPO}/security-scan` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
    const job = await db
      .selectFrom('jobs')
      .selectAll()
      .where('type', '=', 'security_scan')
      .executeTakeFirst();
    expect(job).toBeTruthy();
    expect((job!.payload as { repositoryId: string; trigger: string }).trigger).toBe('manual');
  });

  it('POST security-scan 跨租户仓库 → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/repositories/${uuidv7()}/security-scan`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('跨仓关系 CRUD(§32):create → list → toggle,校验/归属', async () => {
    const REPO_TARGET = uuidv7();
    await db
      .insertInto('repositories')
      .values({
        id: REPO_TARGET,
        tenant_id: TENANT,
        provider_host_id: HOST,
        installation_id: INSTALL,
        native_id: '901',
        namespace: 'acme',
        name: 'client',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();

    const created = await app.inject({
      method: 'POST',
      url: '/v1/repository-relationships',
      payload: {
        sourceRepositoryId: REPO,
        targetRepositoryId: REPO_TARGET,
        kind: 'api-consumer',
        instructions: 'client calls this API',
      },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { id: string }).id;

    const list = await app.inject({ method: 'GET', url: '/v1/repository-relationships' });
    const rels = list.json() as {
      id: string;
      sourceRepositoryId: string;
      kind: string;
      enabled: boolean;
    }[];
    expect(rels.find((r) => r.id === id)).toMatchObject({
      sourceRepositoryId: REPO,
      kind: 'api-consumer',
      enabled: true,
    });

    const toggled = await app.inject({
      method: 'POST',
      url: `/v1/repository-relationships/${id}/toggle`,
      payload: { enabled: false },
    });
    expect(toggled.statusCode).toBe(200);
    const row = await db
      .selectFrom('repository_relationships')
      .select('enabled')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.enabled).toBe(false);
  });

  it('跨仓关系:非法 kind → 400;跨租户目标仓 → 404', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/repository-relationships',
      payload: { sourceRepositoryId: REPO, targetRepositoryId: REPO, kind: 'not-a-kind' },
    });
    expect(bad.statusCode).toBe(400);
    const cross = await app.inject({
      method: 'POST',
      url: '/v1/repository-relationships',
      payload: { sourceRepositoryId: REPO, targetRepositoryId: uuidv7(), kind: 'api-consumer' },
    });
    expect(cross.statusCode).toBe(404);
  });

  it('GET /v1/runners 返回 worker 平表(池是一列)+ 队列计数 + 分页', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/runners' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { pool: string; mode: string; lastHeartbeatAt: string }[];
      total: number;
      limit: number;
      offset: number;
      queuedJobs: number;
    };
    const row = body.items.find((w) => w.pool === 'default');
    expect(row?.mode).toBe('active');
    // The heartbeat is needed to spot dead workers.
    expect(new Date(row!.lastHeartbeatAt).getTime()).toBeGreaterThan(0);
    expect(body.total).toBeGreaterThan(0);
    expect(typeof body.queuedJobs).toBe('number');

    const paged = await app.inject({ method: 'GET', url: '/v1/runners?limit=1&offset=0' });
    const p1 = paged.json() as { items: unknown[]; total: number; limit: number };
    expect(p1.items).toHaveLength(1);
    expect(p1.limit).toBe(1);
    expect(p1.total).toBe(body.total);
  });

  it('GET /v1/usage 默认统计本计费周期,按仓库聚合', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/usage' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totals: { reviews: number; totalTokens: number; costUsd: number };
      byRepository: { repository: string; totalTokens: number }[];
    };
    expect(body.totals.reviews).toBe(1);
    expect(body.totals.totalTokens).toBe(1250);
    expect(body.totals.costUsd).toBeCloseTo(0.05, 5);
    expect(body.byRepository.find((r) => r.repository === 'acme/app')?.totalTokens).toBe(1250);
    expect((await app.inject({ method: 'GET', url: '/v1/usage?since=nope' })).statusCode).toBe(400);
  });

  it('usage 只算 since 之后的评审(上个周期不计入本周期)', async () => {
    const ids = Array.from({ length: 3 }, () => uuidv7());
    const old = new Date(Date.now() - 40 * 86_400_000);
    await db
      .insertInto('review_costs')
      .values(
        ids.map((id) => ({
          id,
          tenant_id: TENANT,
          repository_id: REPO,
          change_request_id: CR,
          revision_id: uuidv7(),
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          cost_usd: 0.001,
          candidate_count: 0,
          published_inline: 0,
          scopes_total: 2,
          scopes_complete: 1,
          created_at: old,
        })),
      )
      .execute();
    try {
      type U = { totals: { reviews: number; totalTokens: number } };
      const current = (await app.inject({ method: 'GET', url: '/v1/usage' })).json() as U;
      expect(current.totals).toMatchObject({ reviews: 1, totalTokens: 1250 });
      const since = new Date(old.getTime() - 1000).toISOString();
      const wide = (await app.inject({ method: 'GET', url: `/v1/usage?since=${since}` })).json() as U;
      expect(wide.totals).toMatchObject({ reviews: 4, totalTokens: 1256 });
    } finally {
      await db.deleteFrom('review_costs').where('id', 'in', ids).execute();
    }
  });

  it('GET /v1/audit 解析操作者与目标,可按操作者/操作筛选;facets 列出取值', async () => {
    const user = uuidv7();
    await db.insertInto('users').values({ id: user, email: 'alice@example.com', display_name: 'Alice', created_at: new Date() }).execute();
    await db
      .insertInto('memberships')
      .values({ id: uuidv7(), tenant_id: TENANT, user_id: user, role: 'admin', status: 'active', created_at: new Date() })
      .execute();
    await db
      .insertInto('user_identities')
      .values({ id: uuidv7(), user_id: user, kind: 'oidc', issuer: 'https://idp.example', subject: 'alice-sub', login: 'alice', tenant_id: null, created_at: new Date() })
      .execute();
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    const at = (n: number) => new Date(Date.now() - n * 1000);
    await db
      .insertInto('audit_events')
      .values([
        { id: ids[0]!, tenant_id: TENANT, actor: 'alice-sub', action: 'finding.dismissed', target: FINDING, detail: {}, created_at: at(3) },
        { id: ids[1]!, tenant_id: TENANT, actor: 'system', action: 'security.scan', target: REPO, detail: {}, created_at: at(2) },
        { id: ids[2]!, tenant_id: OTHER_TENANT, actor: 'alice-sub', action: 'finding.dismissed', target: FINDING, detail: {}, created_at: at(1) },
      ])
      .execute();
    try {
      type A = { items: Record<string, unknown>[]; total: number };
      const all = (await app.inject({ method: 'GET', url: '/v1/audit' })).json() as A;
      const byId = new Map(all.items.map((r) => [r.id, r]));
      expect(byId.has(ids[2]!)).toBe(false);
      expect(byId.get(ids[0]!)).toMatchObject({ actorLabel: 'Alice', targetKind: 'finding', targetLabel: 'off-by-one in add' });
      expect(byId.get(ids[1]!)).toMatchObject({ actorLabel: null, targetKind: 'repository', targetLabel: 'acme/app' });
      const mine = (await app.inject({ method: 'GET', url: '/v1/audit?actor=alice-sub' })).json() as A;
      expect(mine.items.map((r) => r.id)).toEqual([ids[0]]);
      const scans = (await app.inject({ method: 'GET', url: '/v1/audit?action=security.scan' })).json() as A;
      expect(scans.items.map((r) => r.id)).toEqual([ids[1]]);
      const facets = (await app.inject({ method: 'GET', url: '/v1/audit/facets' })).json() as {
        actions: string[];
        actors: { id: string; label: string | null }[];
      };
      expect(facets.actions).toEqual(expect.arrayContaining(['finding.dismissed', 'security.scan']));
      expect(facets.actors).toEqual(expect.arrayContaining([{ id: 'alice-sub', label: 'Alice' }, { id: 'system', label: null }]));
    } finally {
      await db.deleteFrom('audit_events').where('id', 'in', ids).execute();
    }
  });

  it('无 review:read 权限(viewer 有)但无 tenant → 400', async () => {
    const noTenant = await buildServer({
      quiet: true,
      db,
      rbac: { resolveAuth: () => ({ role: 'admin', scopes: ['admin'] }) },
    });
    await noTenant.ready();
    const res = await noTenant.inject({ method: 'GET', url: '/v1/reviews' });
    expect(res.statusCode).toBe(400);
    await noTenant.close();
  });
});
