import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { insertGlobalLearning, newGlobalLearning, transitionGlobalLearning } from '@reviewbot/knowledge';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import type { Role } from '@reviewbot/rbac';
import { buildServer } from '../src/server.js';

const TENANT = uuidv7();
const TENANT_B = uuidv7();
const REPO = uuidv7();

function tenantApp(db: Db, role: Role, tenantId = TENANT): Promise<FastifyInstance> {
  return buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role, scopes: ['admin'], tenantId, actorId: `${role}-sub` }) } });
}

async function seedApprovedGlobal(db: Db, instruction: string, enforcement: 'default' | 'mandatory' = 'default'): Promise<string> {
  const g = newGlobalLearning({ instruction, rationale: 'r', enforcement, proposedBy: 'op' });
  await insertGlobalLearning(db, g);
  const r = await transitionGlobalLearning(db, g.id, { action: 'approve', actor: { isTenantAdmin: false, isPlatformOperator: true, ref: 'op' } });
  expect(r.ok).toBe(true);
  return g.id;
}

describe('control-api Global Learning 租户采纳端点(0029 P2)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let owner: FastifyInstance;
  let admin: FastifyInstance;
  let member: FastifyInstance;
  let ownerB: FastifyInstance;
  let gDefault: string;
  let gMandatory: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    for (const t of [TENANT, TENANT_B]) {
      await db.insertInto('tenants').values({ id: t, name: t.slice(0, 6), region: null, created_at: new Date() }).execute();
    }
    gDefault = await seedApprovedGlobal(db, '全局规则(default)');
    gMandatory = await seedApprovedGlobal(db, '平台基线(mandatory)', 'mandatory');
    owner = await tenantApp(db, 'owner');
    admin = await tenantApp(db, 'admin');
    member = await tenantApp(db, 'member');
    ownerB = await tenantApp(db, 'owner', TENANT_B);
    await Promise.all([owner.ready(), admin.ready(), member.ready(), ownerB.ready()]);
  });

  afterAll(async () => {
    await Promise.all([owner?.close(), admin?.close(), member?.close(), ownerB?.close()]);
    await stop?.();
  });

  it('pending 收件箱:default 列出、mandatory 不列;白名单字段无 source/deliberation/proposedBy', async () => {
    const res = await owner.inject({ method: 'GET', url: '/v1/global-learnings/pending' });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Record<string, unknown>[];
    expect(list.map((p) => p.id)).toEqual([gDefault]);
    for (const k of ['source', 'deliberation', 'proposedBy', 'approvedBy']) expect(list[0]).not.toHaveProperty(k);
  });

  it('授权分级:member 无 learning:approve → 403;admin org 级 / repo 级 → 200', async () => {
    expect((await member.inject({ method: 'POST', url: `/v1/global-learnings/${gDefault}/adopt`, payload: {} })).statusCode).toBe(403);
    expect((await admin.inject({ method: 'POST', url: `/v1/global-learnings/${gDefault}/adopt`, payload: { scope: 'org' } })).statusCode).toBe(200);
    const repoRes = await admin.inject({
      method: 'POST',
      url: `/v1/global-learnings/${gDefault}/adopt`,
      payload: { scope: 'repo', repositoryIds: [REPO] },
    });
    expect(repoRes.statusCode).toBe(200);
    expect(repoRes.json()).toEqual({ status: 'accepted', scope: 'repo' });
  });

  it('owner org 级 decline 覆盖既有决定;repo scope 缺 repositoryIds → 400', async () => {
    expect(
      (await owner.inject({ method: 'POST', url: `/v1/global-learnings/${gDefault}/adopt`, payload: { scope: 'repo' } })).statusCode,
    ).toBe(400);
    const res = await owner.inject({ method: 'POST', url: `/v1/global-learnings/${gDefault}/decline`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'declined', scope: 'org' });
    const pending = (await owner.inject({ method: 'GET', url: '/v1/global-learnings/pending' })).json() as { id: string }[];
    expect(pending.map((p) => p.id)).not.toContain(gDefault);
  });

  it('mandatory 不可采纳/拒绝 → 409;未 approved id → 404;租户隔离(B 仍 pending)', async () => {
    expect((await owner.inject({ method: 'POST', url: `/v1/global-learnings/${gMandatory}/adopt`, payload: {} })).statusCode).toBe(409);
    expect((await owner.inject({ method: 'POST', url: `/v1/global-learnings/${uuidv7()}/adopt`, payload: {} })).statusCode).toBe(404);
    const pendingB = (await ownerB.inject({ method: 'GET', url: '/v1/global-learnings/pending' })).json() as { id: string }[];
    expect(pendingB.map((p) => p.id)).toContain(gDefault); // A's decline does not affect B
  });

  it('GET /v1/rules:租户规则与平台规则合成一张表,按范围计数、按状态筛选,平台行不带运维字段', async () => {
    const created = await ownerB.inject({
      method: 'POST',
      url: '/v1/learnings',
      payload: { broadness: 'organization', instruction: 'org rule', rationale: 'r' },
    });
    expect(created.statusCode).toBeLessThan(300);
    type Rules = { items: Record<string, unknown>[]; total: number; counts: Record<string, number> };
    const all = (await ownerB.inject({ method: 'GET', url: '/v1/rules' })).json() as Rules;
    const byId = new Map(all.items.map((r) => [r.id, r]));
    expect(byId.get(gDefault)).toMatchObject({ scope: 'platform', status: 'recommended', state: 'proposed' });
    expect(byId.get(gMandatory)).toMatchObject({ status: 'mandatory', state: 'active' });
    expect(all.items.find((r) => r.instruction === 'org rule')).toMatchObject({ scope: 'organization', state: 'proposed' });
    expect(all.counts).toMatchObject({ all: 3, platform: 2, organization: 1 });
    for (const r of all.items) for (const k of ['source', 'deliberation', 'proposedBy', 'approvedBy', 'origin', 'confidence']) expect(r).not.toHaveProperty(k);

    const active = (await ownerB.inject({ method: 'GET', url: '/v1/rules?state=active' })).json() as Rules;
    expect(active.items.map((r) => r.id)).toEqual([gMandatory]);
    const platform = (await ownerB.inject({ method: 'GET', url: '/v1/rules?scope=platform' })).json() as Rules;
    expect(platform.total).toBe(2);
    // Tenant A declined the default rule earlier.
    const a = (await owner.inject({ method: 'GET', url: '/v1/rules?scope=platform' })).json() as Rules;
    expect(a.items.find((r) => r.id === gDefault)).toMatchObject({ status: 'declined', state: 'inactive' });
  });
});
