import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { insertEcosystemFact, loadActiveEcosystemFacts } from '@reviewbot/knowledge';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const OPERATOR_SUB = '10864310';

function app(db: Db, subject: string, role: 'viewer' | 'owner'): Promise<FastifyInstance> {
  return buildServer({
    quiet: true,
    db,
    rbac: { resolveAuth: () => ({ role, scopes: [], actorId: subject, identity: { provider: 'github', issuer: 'https://github.com', subject } }) },
  });
}

const SRC = 'https://pub.dev/packages/material_ui';

describe('control-api 生态知识端点(platform-operator)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let operator: FastifyInstance;
  let outsider: FastifyInstance;

  beforeAll(async () => {
    process.env.PLATFORM_OPERATOR_IDENTITIES = `github:${OPERATOR_SUB}`;
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    operator = await app(db, OPERATOR_SUB, 'viewer');
    outsider = await app(db, '999', 'owner');
    await operator.ready();
    await outsider.ready();
  });
  afterAll(async () => {
    await operator?.close();
    await outsider?.close();
    await stop?.();
  });

  it('非运维者(哪怕是 owner)看不到也改不了', async () => {
    expect((await outsider.inject({ method: 'GET', url: '/v1/ecosystem-facts' })).statusCode).toBe(403);
    const post = await outsider.inject({ method: 'POST', url: '/v1/ecosystem-facts', payload: { ecosystem: 'pub', subject: 'x', claim: 'y', sources: [SRC] } });
    expect(post.statusCode).toBe(403);
  });

  it('运维者录入即批准,带默认过期;缺来源 / 非法生态 / 过去的过期时间 → 400', async () => {
    const bad = async (payload: object) => (await operator.inject({ method: 'POST', url: '/v1/ecosystem-facts', payload })).json().error;
    expect(await bad({ ecosystem: 'pub', subject: 'x', claim: 'y', sources: ['not a url'] })).toBe('source_required');
    expect(await bad({ ecosystem: 'dart', subject: 'x', claim: 'y', sources: [SRC] })).toBe('invalid_ecosystem');
    expect(await bad({ ecosystem: 'pub', subject: 'x', claim: 'y', sources: [SRC], expiresAt: '2000-01-01' })).toBe('invalid_expires_at');

    const res = await operator.inject({ method: 'POST', url: '/v1/ecosystem-facts', payload: { ecosystem: 'pub', subject: 'material_ui', claim: 'Standalone Material.', sources: [SRC] } });
    expect(res.statusCode).toBe(201);
    const fact = res.json();
    expect(fact).toMatchObject({ status: 'approved', origin: 'operator', reviewedBy: OPERATOR_SUB });
    const days = (new Date(fact.expiresAt).getTime() - new Date(fact.observedAt).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(180);
  });

  it('review 提交的条目:批准时可改写;已批准的可撤下;非法转移 409', async () => {
    const proposed = await insertEcosystemFact(db, {
      ecosystem: 'pub',
      subject: 'pedantic',
      claim: 'draft',
      sources: [SRC],
      origin: 'review',
      proposedFrom: { tenantId: 't', repositoryId: 'r', revisionId: 'v' },
    });
    const listed = (await operator.inject({ method: 'GET', url: '/v1/ecosystem-facts?status=proposed' })).json();
    expect(listed.items.map((f: { id: string }) => f.id)).toEqual([proposed.id]);
    expect(listed.items[0].proposedFrom.revisionId).toBe('v');

    const approved = await operator.inject({ method: 'POST', url: `/v1/ecosystem-facts/${proposed.id}/approve`, payload: { claim: 'pedantic is discontinued; use lints.', versions: '' } });
    expect(approved.json()).toMatchObject({ status: 'approved', claim: 'pedantic is discontinued; use lints.' });
    expect(approved.json().versions).toBeUndefined();
    expect((await operator.inject({ method: 'POST', url: `/v1/ecosystem-facts/${proposed.id}/approve` })).statusCode).toBe(409);

    expect((await loadActiveEcosystemFacts(db)).map((f) => f.subject).sort()).toEqual(['material_ui', 'pedantic']);
    const withdrawn = await operator.inject({ method: 'POST', url: `/v1/ecosystem-facts/${proposed.id}/reject` });
    expect(withdrawn.json().status).toBe('rejected');
    expect((await operator.inject({ method: 'POST', url: `/v1/ecosystem-facts/${proposed.id}/reject` })).statusCode).toBe(409);
    expect((await loadActiveEcosystemFacts(db)).map((f) => f.subject)).toEqual(['material_ui']);
  });

  it('过期的条目不再生效', async () => {
    await insertEcosystemFact(db, {
      ecosystem: 'npm',
      subject: 'request',
      claim: 'deprecated',
      sources: [SRC],
      origin: 'operator',
      approvedBy: OPERATOR_SUB,
      observedAt: new Date('2020-01-01'),
      expiresAt: new Date('2020-06-01'),
    });
    expect((await loadActiveEcosystemFacts(db)).map((f) => f.subject)).not.toContain('request');
  });

  it('feeds (0004): operator-only CRUD, public URLs only, one feed per URL', async () => {
    const url = 'https://docs.flutter.dev/release/breaking-changes';
    expect((await outsider.inject({ method: 'GET', url: '/v1/ecosystem-fact-feeds' })).statusCode).toBe(403);
    const bad = await operator.inject({ method: 'POST', url: '/v1/ecosystem-fact-feeds', payload: { ecosystem: 'pub', subject: 'flutter', url: 'file:///etc/passwd' } });
    expect(bad.statusCode).toBe(400);
    const created = await operator.inject({ method: 'POST', url: '/v1/ecosystem-fact-feeds', payload: { ecosystem: 'pub', subject: 'flutter', url, label: 'Flutter breaking changes' } });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    const dup = await operator.inject({ method: 'POST', url: '/v1/ecosystem-fact-feeds', payload: { ecosystem: 'pub', subject: 'flutter', url } });
    expect(dup.statusCode).toBe(409);

    expect((await operator.inject({ method: 'POST', url: `/v1/ecosystem-fact-feeds/${id}/disable` })).statusCode).toBe(200);
    const listed = (await operator.inject({ method: 'GET', url: '/v1/ecosystem-fact-feeds' })).json() as { items: { id: string; enabled: boolean }[] };
    expect(listed.items.find((f) => f.id === id)?.enabled).toBe(false);
    expect((await operator.inject({ method: 'POST', url: `/v1/ecosystem-fact-feeds/${id}/refresh` })).statusCode).toBe(200);
    expect((await operator.inject({ method: 'DELETE', url: `/v1/ecosystem-fact-feeds/${id}` })).statusCode).toBe(200);
    expect((await operator.inject({ method: 'DELETE', url: `/v1/ecosystem-fact-feeds/${id}` })).statusCode).toBe(404);
  });
});
