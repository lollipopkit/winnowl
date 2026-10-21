import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { createLocalMasterKey } from '@reviewbot/kms';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();

/** BYOK providers as the server sees them: keys starting with `sk-` work; each offers a few models. */
const OFFERED: Record<string, string[]> = {
  'api.openai.com': ['gpt-4o-mini', 'gpt-5.6-sol', 'mystery-model'],
  'api.deepseek.com': ['deepseek-v4-pro'],
  'api.anthropic.com': ['claude-sonnet-4-5'],
};
const byokFetch: typeof fetch = async (url, init) => {
  const h = new Headers(init?.headers);
  const key = h.get('x-api-key') ?? h.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!key.startsWith('sk-')) return new Response('{}', { status: 401 });
  return Response.json({ data: (OFFERED[new URL(String(url)).host] ?? []).map((id) => ({ id })) });
};

describe('control-api BYOK 端点(todos §BYOK)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let admin: FastifyInstance;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '88', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '801', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    admin = await buildServer({
      quiet: true,
      db,
      masterKey: createLocalMasterKey('kek-test', randomBytes(32)),
      byokFetch,
      rbac: { resolveAuth: () => ({ role: 'admin', scopes: ['admin'], tenantId: TENANT, actorId: 'alice' }) },
    });
    await admin.ready();
  });

  afterAll(async () => {
    await admin?.close();
    await stop?.();
  });

  it('PUT org 级 → 204 密文落库;GET 回非密元数据(provider/model,永不含 apiKey)', async () => {
    const res = await admin.inject({
      method: 'PUT',
      url: '/v1/byok',
      payload: { provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'sk-byok-secret', modelCheap: 'gpt-4o-mini' },
    });
    expect(res.statusCode).toBe(204);
    const rows = await db.selectFrom('service_credentials').selectAll().where('tenant_id', '=', TENANT).where('service', '=', 'llm').execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.envelope)).not.toContain('sk-byok-secret');

    const get = await admin.inject({ method: 'GET', url: '/v1/byok' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({
      byok: { provider: 'openai', model: 'gpt-5.6-sol', modelCheap: 'gpt-4o-mini' },
      repositories: [],
      providers: ['openai', 'anthropic', 'openrouter', 'deepseek'],
    });
    expect(get.body).not.toContain('sk-byok-secret');
  });

  it('checks the configuration with the provider before storing it; refusals say which field and why', async () => {
    const put = (payload: Record<string, unknown>) => admin.inject({ method: 'PUT', url: '/v1/byok', payload });
    const refused = async (payload: Record<string, unknown>) => {
      const res = await put(payload);
      return { status: res.statusCode, ...(res.json() as { error: string; reason: string; field?: string }) };
    };
    expect(await refused({ provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'bad-key' })).toMatchObject({ status: 400, error: 'byok_check_failed', reason: 'key_rejected' });
    expect(await refused({ provider: 'openai', model: 'gpt-9', apiKey: 'sk-x' })).toMatchObject({ status: 400, reason: 'model_unavailable', field: 'model' });
    expect(await refused({ provider: 'openai', model: 'mystery-model', apiKey: 'sk-x' })).toMatchObject({ status: 400, reason: 'model_spec_unknown', field: 'model' });
    // A different provider needs its own key; the same provider keeps the stored one.
    expect(await refused({ provider: 'deepseek', model: 'deepseek-v4-pro' })).toMatchObject({ status: 400, reason: 'missing_field', field: 'apiKey' });
    expect((await put({ provider: 'openai', model: 'gpt-4o-mini' })).statusCode).toBe(204);
    const get = (await admin.inject({ method: 'GET', url: '/v1/byok' })).json() as { byok: { model: string; modelCheap?: string } };
    expect(get.byok).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    // Nothing above replaced the stored key: listing models with it still works.
    const models = await admin.inject({ method: 'POST', url: '/v1/byok/models', payload: { provider: 'openai' } });
    expect(models.json()).toEqual({
      models: [
        { id: 'gpt-4o-mini', known: true },
        { id: 'gpt-5.6-sol', known: true },
        { id: 'mystery-model', known: false },
      ],
    });
    expect((await admin.inject({ method: 'POST', url: '/v1/byok/models', payload: { provider: 'deepseek', apiKey: 'nope' } })).json()).toMatchObject({ reason: 'key_rejected' });
    expect((await put({ provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'sk-byok-secret', modelCheap: 'gpt-4o-mini' })).statusCode).toBe(204);
  });

  it('未知 provider / URL 类字段 → 400(端点平台固定,禁止自定义网关)', async () => {
    expect((await admin.inject({ method: 'PUT', url: '/v1/byok', payload: { provider: 'evil', model: 'm', apiKey: 'k' } })).statusCode).toBe(400);
    const res = await admin.inject({
      method: 'PUT',
      url: '/v1/byok',
      payload: { provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_byok_config', reason: 'unknown_field', field: 'baseUrl' });
  });

  it('repo 级 PUT(归属校验)+ GET ?repositoryId + DELETE', async () => {
    expect((await admin.inject({ method: 'PUT', url: '/v1/byok', payload: { provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'sk-r', repositoryId: uuidv7() } })).statusCode).toBe(404);
    expect((await admin.inject({ method: 'PUT', url: '/v1/byok', payload: { provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'sk-r', repositoryId: REPO } })).statusCode).toBe(204);
    const get = await admin.inject({ method: 'GET', url: `/v1/byok?repositoryId=${REPO}` });
    expect(get.json()).toMatchObject({ byok: { provider: 'deepseek' }, inherited: null });
    expect(((await admin.inject({ method: 'GET', url: '/v1/byok' })).json() as { repositories: string[] }).repositories).toEqual([REPO]);

    expect((await admin.inject({ method: 'DELETE', url: '/v1/byok', payload: { repositoryId: REPO } })).statusCode).toBe(204);
    // Without its own, the repository shows what its reviews use: the organisation's.
    expect((await admin.inject({ method: 'GET', url: `/v1/byok?repositoryId=${REPO}` })).json()).toMatchObject({ byok: null, inherited: { provider: 'openai' } });
    expect(((await admin.inject({ method: 'GET', url: '/v1/byok' })).json() as { byok: { provider: string } }).byok.provider).toBe('openai');
  });

  it('非 Admin(member)→ 403', async () => {
    const member = await buildServer({
      quiet: true,
      db,
      masterKey: createLocalMasterKey('k3', randomBytes(32)),
      rbac: { resolveAuth: () => ({ role: 'member', scopes: [], tenantId: TENANT, actorId: 'bob' }) },
    });
    await member.ready();
    expect((await member.inject({ method: 'PUT', url: '/v1/byok', payload: { provider: 'openai', model: 'm', apiKey: 'k' } })).statusCode).toBe(403);
    await member.close();
  });

  it('user 级 self-service /v1/my/byok:viewer+ 为自己配 key(需 userId);PUT/GET(脱敏)/DELETE 往返', async () => {
    const USER = uuidv7();
    await db.insertInto('users').values({ id: USER, email: 'self@acme.io', display_name: 'Self', created_at: new Date() }).execute();
    const selfServe = await buildServer({
      quiet: true,
      db,
      masterKey: createLocalMasterKey('k-self', randomBytes(32)),
      byokFetch,
      rbac: { resolveAuth: () => ({ role: 'viewer', scopes: [], tenantId: TENANT, actorId: 'self', userId: USER }) },
    });
    await selfServe.ready();

    expect((await selfServe.inject({ method: 'PUT', url: '/v1/my/byok', payload: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-self-secret' } })).statusCode).toBe(204);
    // Stored at user level, ciphertext without plaintext.
    const row = await db.selectFrom('service_credentials').select(['user_id', 'envelope']).where('tenant_id', '=', TENANT).where('service', '=', 'llm').where('user_id', '=', USER).executeTakeFirstOrThrow();
    expect(row.user_id).toBe(USER);
    expect(JSON.stringify(row.envelope)).not.toContain('sk-self-secret');
    const get = await selfServe.inject({ method: 'GET', url: '/v1/my/byok' });
    expect(get.json()).toEqual({ byok: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, providers: ['openai', 'anthropic', 'openrouter', 'deepseek'] });
    // The model list uses the user's stored key.
    expect((await selfServe.inject({ method: 'POST', url: '/v1/my/byok/models', payload: { provider: 'anthropic' } })).json()).toEqual({
      models: [{ id: 'claude-sonnet-4-5', known: true }],
    });
    expect(get.body).not.toContain('sk-self-secret');
    // URL fields are rejected (endpoints are fixed).
    expect((await selfServe.inject({ method: 'PUT', url: '/v1/my/byok', payload: { provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'https://evil' } })).statusCode).toBe(400);
    expect((await selfServe.inject({ method: 'DELETE', url: '/v1/my/byok' })).statusCode).toBe(204);
    expect(((await selfServe.inject({ method: 'GET', url: '/v1/my/byok' })).json() as { byok: unknown }).byok).toBeNull();
    await selfServe.close();
  });

  it('claims 模式(无 userId)→ /v1/my/byok 400', async () => {
    const noUser = await buildServer({
      quiet: true,
      db,
      masterKey: createLocalMasterKey('k-nouser', randomBytes(32)),
      rbac: { resolveAuth: () => ({ role: 'viewer', scopes: [], tenantId: TENANT, actorId: 'x' }) },
    });
    await noUser.ready();
    expect((await noUser.inject({ method: 'GET', url: '/v1/my/byok' })).statusCode).toBe(400);
    await noUser.close();
  });
});
