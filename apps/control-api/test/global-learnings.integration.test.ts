import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { insertGlobalLearning, newGlobalLearning } from '@reviewbot/knowledge';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const OPERATOR_SUB = '10864310';
const OPERATOR_IDENTITY = { provider: 'github', issuer: 'https://github.com', subject: OPERATOR_SUB };

function operatorApp(db: Db): Promise<FastifyInstance> {
  return buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role: 'viewer', scopes: [], actorId: OPERATOR_SUB, identity: OPERATOR_IDENTITY }) } });
}
function outsiderApp(db: Db): Promise<FastifyInstance> {
  // Tenant owner but not allowlisted: no operator rights.
  return buildServer({
    quiet: true,
    db,
    rbac: { resolveAuth: () => ({ role: 'owner', scopes: ['admin'], actorId: '999', identity: { provider: 'github', issuer: 'https://github.com', subject: '999' } }) },
  });
}

describe('control-api Global Learning 端点(§P3 platform-operator)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let operator: FastifyInstance;
  let outsider: FastifyInstance;

  beforeAll(async () => {
    process.env.PLATFORM_OPERATOR_IDENTITIES = `github:${OPERATOR_SUB}, github:other-op`;
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    operator = await operatorApp(db);
    outsider = await outsiderApp(db);
    await operator.ready();
    await outsider.ready();
  });

  afterAll(async () => {
    await operator?.close();
    await outsider?.close();
    await stop?.();
    delete process.env.PLATFORM_OPERATOR_IDENTITIES;
  });

  it('非白名单主体 → 403(即使 owner)', async () => {
    expect((await outsider.inject({ method: 'GET', url: '/v1/global-learnings' })).statusCode).toBe(403);
    expect(
      (await outsider.inject({ method: 'POST', url: '/v1/global-learnings', payload: { instruction: 'x', rationale: 'y' } })).statusCode,
    ).toBe(403);
  });

  it('platform-operator:propose → 201 proposed;approve → 200 approved', async () => {
    const res = await operator.inject({
      method: 'POST',
      url: '/v1/global-learnings',
      payload: { instruction: '全局:始终校验租户作用域', rationale: 'r', enforcement: 'mandatory' },
    });
    expect(res.statusCode).toBe(201);
    const g = res.json() as { id: string; status: string; enforcement: string };
    expect(g.status).toBe('proposed');
    expect(g.enforcement).toBe('mandatory');

    const approved = await operator.inject({ method: 'POST', url: `/v1/global-learnings/${g.id}/approve` });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'approved' });

    const list = await operator.inject({ method: 'GET', url: '/v1/global-learnings' });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('operator proposal takes an optional future expiry (0003); a past one is rejected', async () => {
    const at = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const res = await operator.inject({ method: 'POST', url: '/v1/global-learnings', payload: { instruction: 'until framework 4', rationale: 'r', expiresAt: at } });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { expiresAt?: number }).expiresAt).toBe(new Date(at).getTime());
    const past = await operator.inject({ method: 'POST', url: '/v1/global-learnings', payload: { instruction: 'x', rationale: 'r', expiresAt: 'yesterday' } });
    expect(past.statusCode).toBe(400);
  });

  it('缺 instruction/rationale → 400', async () => {
    expect((await operator.inject({ method: 'POST', url: '/v1/global-learnings', payload: { instruction: 'only' } })).statusCode).toBe(400);
  });

  it('detail 端点:auto 提议返回完整 deliberation;缺失 → 404', async () => {
    const g = newGlobalLearning({
      instruction: 'auto 全局规则',
      rationale: 'r',
      proposedBy: 'system',
      origin: 'auto',
      confidence: 0.72,
      deliberation: {
        evidence: ['e1'],
        draftModel: 'm-draft',
        panel: [
          { model: 'a', decision: 'approve', confidence: 0.8, reasoning: 'ok' },
          { model: 'b', decision: 'reject', confidence: 0.4, reasoning: 'meh' },
        ],
        aggregate: { confidence: 0.72, approvals: 1, total: 2 },
      },
    });
    await insertGlobalLearning(db, g);

    const res = await operator.inject({ method: 'GET', url: `/v1/global-learnings/${g.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { origin: string; confidence: number; deliberation: { panel: unknown[]; draftModel: string } };
    expect(body.origin).toBe('auto');
    expect(body.confidence).toBe(0.72);
    expect(body.deliberation.panel).toHaveLength(2);
    expect(body.deliberation.draftModel).toBe('m-draft');

    expect((await outsider.inject({ method: 'GET', url: `/v1/global-learnings/${g.id}` })).statusCode).toBe(403);
    expect((await operator.inject({ method: 'GET', url: `/v1/global-learnings/${'00000000-0000-7000-8000-000000000000'}` })).statusCode).toBe(404);
  });
});
