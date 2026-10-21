import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActionPlan, type ActionPlan } from '@reviewbot/actions';
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

function makePlan(id: string): ActionPlan {
  return {
    id,
    conversationId: CONV,
    actorId: 'alice',
    revisionSha: 'head-1',
    actions: [{ type: 'create-stacked-pr', description: 'fix' }],
    requiredPermissions: ['action:approve'],
    expiresAt: 4_000_000_000_000,
    status: 'proposed',
  };
}

describe('inbox', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let alice: FastifyInstance;
  let bob: FastifyInstance;

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
    const build = (actorId: string, role: 'admin' | 'member') =>
      buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role, scopes: [], tenantId: TENANT, actorId }) } });
    alice = await build('alice', 'admin');
    bob = await build('bob', 'member');
    await insertActionPlan(db, TENANT, makePlan(uuidv7()));
    await db
      .insertInto('learning_proposals')
      .values({ id: uuidv7(), tenant_id: TENANT, repository_id: REPOSITORY, instruction: 'skip late final', rationale: 'r', proposed_by: 'bot', status: 'proposed' })
      .execute();
    await db
      .insertInto('notifications')
      .values({ id: uuidv7(), tenant_id: TENANT, kind: 'quota-warning', title: 'cost 72%', body: '', link: '/usage', created_at: new Date() })
      .execute();
  });

  afterAll(async () => {
    await alice?.close();
    await bob?.close();
    await stop?.();
  });

  const get = async (app: FastifyInstance, url: string) => (await app.inject({ method: 'GET', url })).json();

  it('lists what the viewer can decide', async () => {
    const kinds = (await get(alice, '/v1/inbox')).items.map((i: { kind: string }) => i.kind).sort();
    expect(kinds).toEqual(['notification', 'plan', 'rule']);
    const plan = (await get(alice, '/v1/inbox')).items.find((i: { kind: string }) => i.kind === 'plan');
    expect(plan.plan).toMatchObject({ repository: 'acme/app', changeNumber: 1 });
    expect((await get(alice, '/v1/inbox/count')).pending).toBe(3);
  });

  it("hides other actors' plans and approvals the viewer cannot make", async () => {
    const kinds = (await get(bob, '/v1/inbox')).items.map((i: { kind: string }) => i.kind);
    expect(kinds).toEqual(['notification']);
  });

  it('declining moves a plan to done; only its proposer may decline it', async () => {
    const id = (await get(alice, '/v1/inbox')).items.find((i: { kind: string }) => i.kind === 'plan').sourceId;
    expect((await bob.inject({ method: 'POST', url: `/v1/action-plans/${id}/decline` })).statusCode).toBe(409);
    const res = await alice.inject({ method: 'POST', url: `/v1/action-plans/${id}/decline` });
    expect(res.json()).toEqual({ status: 'declined' });
    expect((await alice.inject({ method: 'POST', url: `/v1/action-plans/${id}/decline` })).statusCode).toBe(409);
    const done = (await get(alice, '/v1/inbox?view=done')).items.find((i: { sourceId: string }) => i.sourceId === id);
    expect(done.decided.outcome).toBe('declined');
    expect((await get(alice, '/v1/inbox/count')).pending).toBe(2);
  });
});
