import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createDb, type Db } from '@reviewbot/db';
import { createLocalMasterKey } from '@reviewbot/kms';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { loadInstanceProviders, normalizeInstanceUrl, upsertLoginInstance } from '../src/auth/instances.js';

const OP = { role: 'viewer' as const, scopes: [] as string[], actorId: '1', identity: { provider: 'github', issuer: 'https://github.com', subject: '1' } };

// Must be long: a short secret can appear in the base64 ciphertext by chance and flake the "no plaintext" assertion.
const SECRET_2 = 'forgejo-client-secret-must-not-be-stored-in-plaintext';

describe('自建 Forgejo 登录源(§39.3:登记是特权动作)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let operator: FastifyInstance;
  let outsider: FastifyInstance;
  const masterKey = createLocalMasterKey('k1', randomBytes(32));
  const prevOperators = process.env.PLATFORM_OPERATOR_IDENTITIES;

  beforeAll(async () => {
    process.env.PLATFORM_OPERATOR_IDENTITIES = 'github:1';
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    operator = await buildServer({ quiet: true, db, masterKey, rbac: { resolveAuth: () => OP } });
    outsider = await buildServer({
      quiet: true,
      db,
      masterKey,
      rbac: { resolveAuth: () => ({ role: 'owner', scopes: ['admin'], actorId: '2', identity: { provider: 'github', issuer: 'https://github.com', subject: '2' } }) },
    });
    await Promise.all([operator.ready(), outsider.ready()]);
  });

  afterAll(async () => {
    await Promise.all([operator?.close(), outsider?.close()]);
    await stop?.();
    if (prevOperators === undefined) delete process.env.PLATFORM_OPERATOR_IDENTITIES;
    else process.env.PLATFORM_OPERATOR_IDENTITIES = prevOperators;
  });

  it('地址归一化:补 https、小写 host、丢路径;http 一律拒(localhost 除外)', () => {
    expect(normalizeInstanceUrl('git.example.com')).toBe('https://git.example.com');
    expect(normalizeInstanceUrl('https://Git.Example.com/some/path?x=1')).toBe('https://git.example.com');
    expect(normalizeInstanceUrl('http://localhost:3000')).toBe('http://localhost:3000');
    // Plain http would expose credentials.
    expect(() => normalizeInstanceUrl('http://git.example.com')).toThrow(/https/);
    expect(() => normalizeInstanceUrl('not a url')).toThrow();
  });

  it('**非平台运维不能登记**(登记 = 定义 issuer = 决定那台实例上的谁是谁)', async () => {
    const r = await outsider.inject({
      method: 'POST',
      url: '/v1/auth/instances',
      headers: { origin: process.env.CONSOLE_BASE_URL ?? 'https://console.test' },
      payload: { url: 'git.evil.test', clientId: 'c', clientSecret: 's' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('登记 → 出现在登录源列表;client_secret 不回前端', async () => {
    const created = await upsertLoginInstance(db, masterKey, {
      provider: 'forgejo',
      url: 'https://git.example.com',
      clientId: 'client-1',
      clientSecret: 'super-secret',
    });
    expect(created.issuer).toBe('https://git.example.com');
    expect(created.label).toBe('git.example.com'); // default label = host

    const list = await operator.inject({ method: 'GET', url: '/v1/auth/instances' });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain('super-secret');

    const providers = await operator.inject({ method: 'GET', url: '/v1/auth/providers' });
    const items = (providers.json() as { items: { id: string; kind: string }[] }).items;
    expect(items.find((i) => i.id === 'git.example.com')?.kind).toBe('instance');
  });

  it('同一 origin 只有一条:再次登记是**更新凭据**,不是新增(否则可抢注既有 origin)', async () => {
    await upsertLoginInstance(db, masterKey, { provider: 'forgejo', url: 'git.example.com', clientId: 'client-2', clientSecret: SECRET_2 });
    const rows = await db.selectFrom('login_instances').selectAll().where('issuer', '=', 'https://git.example.com').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client_id).toBe('client-2');
  });

  it('凭据加密落库,取用时解开还原', async () => {
    const row = await db.selectFrom('login_instances').selectAll().where('issuer', '=', 'https://git.example.com').executeTakeFirstOrThrow();
    expect(JSON.stringify(row.secret_envelope)).not.toContain(SECRET_2);
    const providers = await loadInstanceProviders(db, masterKey);
    const p = providers.get('git.example.com');
    expect(p?.label).toBe('git.example.com');
    expect(p?.authorizeUrl({ redirectUri: 'https://console.test/cb', state: 'st' })).toContain('https://git.example.com/login/oauth/authorize');
  });

  it('未登记的 host 去 start → 跳登录页报未知来源,不发起任何外呼', async () => {
    const prev = process.env.CONSOLE_BASE_URL;
    process.env.CONSOLE_BASE_URL = 'https://console.test';
    const r = await operator.inject({ method: 'GET', url: '/v1/auth/git.unknown.test/start' });
    expect(r.headers.location).toBe('https://console.test/?auth_error=unknown_provider');
    if (prev === undefined) delete process.env.CONSOLE_BASE_URL;
    else process.env.CONSOLE_BASE_URL = prev;
  });
});
