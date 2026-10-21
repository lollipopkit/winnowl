import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();

async function adminApp(db: Db): Promise<FastifyInstance> {
  const app = await buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role: 'admin', scopes: ['admin'], tenantId: TENANT, actorId: 'alice' }) } });
  await app.ready();
  return app;
}

describe('control-api Learning 审批端点', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '1', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    app = await adminApp(db);
  });

  afterAll(async () => {
    await app?.close();
    await stop?.();
  });

  async function propose(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/v1/learnings', payload: { repositoryId: REPO, instruction: '用 X', rationale: '因为 Y' } });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it('提议 → 201 proposed', async () => {
    const id = await propose();
    expect(id).toBeTruthy();
  });

  it('manual proposal takes an optional future expiry; a past one is rejected', async () => {
    const at = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const ok = await app.inject({ method: 'POST', url: '/v1/learnings', payload: { repositoryId: REPO, instruction: 'until v2', rationale: 'r', expiresAt: at } });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { expiresAt?: number }).expiresAt).toBe(new Date(at).getTime());
    const listed = await app.inject({ method: 'GET', url: '/v1/learnings?q=until%20v2' });
    expect((listed.json() as { items: { expiresAt?: number }[] }).items[0]?.expiresAt).toBe(new Date(at).getTime());
    const past = await app.inject({ method: 'POST', url: '/v1/learnings', payload: { repositoryId: REPO, instruction: 'x', rationale: 'r', expiresAt: '2020-01-01' } });
    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({ error: 'invalid_expires_at' });
  });

  it('Admin approve → 200 approved', async () => {
    const id = await propose();
    const res = await app.inject({ method: 'POST', url: `/v1/learnings/${id}/approve` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'approved' });
  });

  it('非 Admin(member)approve → 403', async () => {
    const id = await propose();
    const member = await buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role: 'member', scopes: [], tenantId: TENANT, actorId: 'bob' }) } });
    await member.ready();
    const res = await member.inject({ method: 'POST', url: `/v1/learnings/${id}/approve` });
    expect(res.statusCode).toBe(403);
    await member.close();
  });

  it('已 approved 再 approve → 409', async () => {
    const id = await propose();
    await app.inject({ method: 'POST', url: `/v1/learnings/${id}/approve` });
    const again = await app.inject({ method: 'POST', url: `/v1/learnings/${id}/approve` });
    expect(again.statusCode).toBe(409);
  });

  it('GET /v1/learnings 列出', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/learnings' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('organization 广度:admin 提 201,本租户 admin 直接 approve 200', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/learnings', payload: { broadness: 'organization', instruction: 'ORG 规则', rationale: 'r' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; broadness: string; repositoryId: string | null };
    expect(body.broadness).toBe('organization');
    expect(body.repositoryId).toBeNull();
    expect((await app.inject({ method: 'POST', url: `/v1/learnings/${body.id}/approve` })).statusCode).toBe(200);
  });

  it('member 提 organization 广度 → 403(缺 learning:propose:org)', async () => {
    const member = await buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role: 'member', scopes: [], tenantId: TENANT, actorId: 'bob' }) } });
    await member.ready();
    expect((await member.inject({ method: 'POST', url: '/v1/learnings', payload: { broadness: 'organization', instruction: 'x', rationale: 'y' } })).statusCode).toBe(403);
    await member.close();
  });

  it('user 广度:带 subjectRef 提 201 + repositoryId 空;缺 subjectRef → 400(§P4)', async () => {
    const ok = await app.inject({ method: 'POST', url: '/v1/learnings', payload: { broadness: 'user', subjectRef: 'github:1001', instruction: 'USER 规则', rationale: 'r' } });
    expect(ok.statusCode).toBe(201);
    const body = ok.json() as { broadness: string; repositoryId: string | null; subjectRef?: string };
    expect(body.broadness).toBe('user');
    expect(body.repositoryId).toBeNull();
    expect(body.subjectRef).toBe('github:1001');
    const bad = await app.inject({ method: 'POST', url: '/v1/learnings', payload: { broadness: 'user', instruction: 'x', rationale: 'y' } });
    expect(bad.statusCode).toBe(400);
    // Only numeric ids: logins can be renamed or recycled.
    const byLogin = await app.inject({ method: 'POST', url: '/v1/learnings', payload: { broadness: 'user', subjectRef: 'github:alice', instruction: 'x', rationale: 'y' } });
    expect(byLogin.statusCode).toBe(400);
  });
});
