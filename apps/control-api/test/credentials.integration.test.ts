import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { createLocalMasterKey } from '@reviewbot/kms';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const TENANT = uuidv7();
const OTHER_TENANT = uuidv7();
const HOST = uuidv7();
const OTHER_HOST = uuidv7();
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIsecret\n-----END RSA PRIVATE KEY-----';

describe('control-api 凭据管理端点', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let admin: FastifyInstance;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    const masterKey = createLocalMasterKey('kek-test', randomBytes(32));
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('tenants').values({ id: OTHER_TENANT, name: 'other', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: OTHER_HOST, tenant_id: OTHER_TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    admin = await buildServer({ quiet: true, db, masterKey, rbac: { resolveAuth: () => ({ role: 'admin', scopes: ['admin'], tenantId: TENANT, actorId: 'alice' }) } });
    await admin.ready();
  });

  afterAll(async () => {
    await admin?.close();
    await stop?.();
  });

  it('Admin 写入 github-app 凭据 → 204,且落库为密文(不含明文 PEM)', async () => {
    const res = await admin.inject({ method: 'POST', url: '/v1/provider-credentials', payload: { hostId: HOST, kind: 'github-app', appId: '42', privateKeyPem: PEM } });
    expect(res.statusCode).toBe(204);
    const row = await db.selectFrom('provider_credentials').selectAll().where('provider_host_id', '=', HOST).where('kind', '=', 'github-app').executeTakeFirstOrThrow();
    expect(JSON.stringify(row.envelope)).not.toContain('MIIsecret');
  });

  it('缺 appId/privateKeyPem → 400', async () => {
    const res = await admin.inject({ method: 'POST', url: '/v1/provider-credentials', payload: { hostId: HOST, kind: 'github-app' } });
    expect(res.statusCode).toBe(400);
  });

  it('跨租户 host → 404', async () => {
    const res = await admin.inject({ method: 'POST', url: '/v1/provider-credentials', payload: { hostId: OTHER_HOST, kind: 'github-app', appId: '1', privateKeyPem: PEM } });
    expect(res.statusCode).toBe(404);
  });

  it('非 Admin(member)→ 403', async () => {
    const member = await buildServer({ quiet: true, db, masterKey: createLocalMasterKey('k2', randomBytes(32)), rbac: { resolveAuth: () => ({ role: 'member', scopes: [], tenantId: TENANT, actorId: 'bob' }) } });
    await member.ready();
    const res = await member.inject({ method: 'POST', url: '/v1/provider-credentials', payload: { hostId: HOST, kind: 'github-app', appId: '1', privateKeyPem: PEM } });
    expect(res.statusCode).toBe(403);
    await member.close();
  });
});
