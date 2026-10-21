import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';


const TENANT = uuidv7();
const CONV = uuidv7();
const HOST = uuidv7();
const INSTALLATION = uuidv7();
const REPOSITORY = uuidv7();
const CHANGE_REQUEST = uuidv7();
const REVISION = uuidv7();

describe('finding actions', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let app: FastifyInstance;
  const FINDING = uuidv7();

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
        id: INSTALLATION,
        tenant_id: TENANT,
        provider_host_id: HOST,
        native_id: 'i1',
        account_login: 'acme',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('repositories')
      .values({
        id: REPOSITORY,
        tenant_id: TENANT,
        provider_host_id: HOST,
        installation_id: INSTALLATION,
        native_id: 'r1',
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
        id: CHANGE_REQUEST,
        tenant_id: TENANT,
        repository_id: REPOSITORY,
        native_id: '1',
        number: 1,
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
        id: REVISION,
        tenant_id: TENANT,
        change_request_id: CHANGE_REQUEST,
        base_sha: 'base',
        head_sha: 'head-1',
        merge_base_sha: null,
        source_branch: 'feat',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('conversations')
      .values({
        id: CONV,
        tenant_id: TENANT,
        target_kind: 'change-request',
        target_native_id: '1',
        state: 'active',
        context_revision_sha: 'head-1',
        summary: '',
        active_task_id: null,
        repository_id: REPOSITORY,
        change_request_id: CHANGE_REQUEST,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('findings')
      .values({ id: FINDING, tenant_id: TENANT, repository_id: REPOSITORY, semantic_fingerprint: 'fp', category: 'correctness', canonical_claim: 'off by one', lifecycle: 'new', first_seen_at: new Date(), last_seen_at: new Date() })
      .execute();
    await db
      .insertInto('finding_occurrences')
      .values({ id: uuidv7(), tenant_id: TENANT, finding_id: FINDING, revision_id: REVISION, state: 'inline', severity: 'high', change_relation: 'introduced', confirmation: 'independently-verified', anchor_text: 'i <= n', anchor: { path: 'a.ts', line: 3 }, created_at: new Date() })
      .execute();
    app = await buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role: 'member', scopes: [], tenantId: TENANT, actorId: 'alice' }) } });
  });

  afterAll(async () => {
    await app?.close();
    await stop?.();
  });

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload });
  const ids = async (status: string) =>
    ((await app.inject({ method: 'GET', url: `/v1/findings?status=${status}` })).json() as { items: { id: string }[] }).items.map((f) => f.id);

  it('dismiss records the reason, proposes a rule and queues a merge-check recompute', async () => {
    expect((await post(`/v1/findings/${FINDING}/dismiss`, { changeRequestId: CHANGE_REQUEST, reason: 'nope' })).statusCode).toBe(400);
    const res = await post(`/v1/findings/${FINDING}/dismiss`, { changeRequestId: CHANGE_REQUEST, reason: 'false-positive', proposeRule: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().ruleId).toBeTruthy();
    expect(await ids('dismissed')).toEqual([FINDING]);
    expect(await ids('open')).toEqual([]);
    const detail = (await app.inject({ method: 'GET', url: `/v1/findings/${FINDING}` })).json();
    expect(detail.dismissal).toMatchObject({ reason: 'false-positive', actor: 'alice' });
    const rule = await db.selectFrom('learning_proposals').select(['status', 'repository_id']).where('id', '=', res.json().ruleId).executeTakeFirstOrThrow();
    expect(rule).toEqual({ status: 'proposed', repository_id: REPOSITORY });
    const jobs = await db.selectFrom('jobs').select('type').where('tenant_id', '=', TENANT).execute();
    expect(jobs.map((j) => j.type)).toContain('recompute_gate');
  });

  it('undismiss restores the finding', async () => {
    expect((await post(`/v1/findings/${FINDING}/undismiss`, { changeRequestId: CHANGE_REQUEST })).statusCode).toBe(200);
    expect(await ids('open')).toEqual([FINDING]);
    expect((await post(`/v1/findings/${FINDING}/undismiss`, { changeRequestId: CHANGE_REQUEST })).statusCode).toBe(404);
  });

  it('requesting a fix proposes a plan that waits in the inbox', async () => {
    const res = await post(`/v1/findings/${FINDING}/fix`, { changeRequestId: CHANGE_REQUEST });
    expect(res.statusCode).toBe(201);
    const inbox = (await app.inject({ method: 'GET', url: '/v1/inbox' })).json() as { items: { kind: string; sourceId: string }[] };
    expect(inbox.items.find((i) => i.kind === 'plan')?.sourceId).toBe(res.json().planId);
  });

  it('other tenants cannot act on the finding', async () => {
    expect((await post(`/v1/findings/${FINDING}/fix`, { changeRequestId: uuidv7() })).statusCode).toBe(404);
  });
});
