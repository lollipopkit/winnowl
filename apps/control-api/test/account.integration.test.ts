import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const TENANT = uuidv7();
const USER_A = uuidv7();

/** Linking is covered in auth-flow.integration.test.ts; this covers listing and unlinking. */
describe('账号身份端点(0047:多 forge 身份统一)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let asA: FastifyInstance;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('users').values({ id: USER_A, email: 'a@x.io', display_name: null, created_at: new Date() }).execute();
    await db.insertInto('user_identities').values([
      { id: uuidv7(), user_id: USER_A, kind: 'provider', issuer: 'https://github.com', subject: '1', login: 'alice', provider: 'github', tenant_id: null, created_at: new Date() },
      { id: uuidv7(), user_id: USER_A, kind: 'provider', issuer: 'https://git.acme.com', subject: '9', login: 'alice', provider: 'forgejo', tenant_id: null, created_at: new Date() },
    ]).execute();

    const auth = { role: 'viewer' as const, scopes: [] as string[], actorId: '1', userId: USER_A };
    asA = await buildServer({ quiet: true, db, rbac: { resolveAuth: () => auth } });
    await asA.ready();
  });

  afterAll(async () => {
    await asA?.close();
    await stop?.();
  });

  it('身份列表是账号自己的事 —— viewer(无 membership)也能读', async () => {
    const r = await asA.inject({ method: 'GET', url: '/v1/account/identities' });
    expect(r.statusCode).toBe(200);
    const items = (r.json() as { items: { issuer: string }[] }).items;
    expect(items.map((i) => i.issuer).sort()).toEqual(['https://git.acme.com', 'https://github.com']);
  });

  it('解绑:多余的可解,最后一条 409(否则用户把自己锁在门外)', async () => {
    const items = (await asA.inject({ method: 'GET', url: '/v1/account/identities' })).json() as { items: { id: string; provider?: string }[] };
    const forgejo = items.items.find((i) => i.provider === 'forgejo')!;
    expect((await asA.inject({ method: 'DELETE', url: `/v1/account/identities/${forgejo.id}` })).statusCode).toBe(200);

    const left = (await asA.inject({ method: 'GET', url: '/v1/account/identities' })).json() as { items: { id: string }[] };
    expect(left.items).toHaveLength(1);
    const r = await asA.inject({ method: 'DELETE', url: `/v1/account/identities/${left.items[0]!.id}` });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: string }).error).toBe('last_identity');

    // Someone else's identity -> 404, without revealing existence.
    expect((await asA.inject({ method: 'DELETE', url: `/v1/account/identities/${uuidv7()}` })).statusCode).toBe(404);
  });
});
