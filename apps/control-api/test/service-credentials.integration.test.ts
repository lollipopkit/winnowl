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

describe('control-api 插件服务凭据端点(§插件 BYOK,0033)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let admin: FastifyInstance;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '77', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '701', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    admin = await buildServer({
      quiet: true,
      db,
      masterKey: createLocalMasterKey('kek-test', randomBytes(32)),
      rbac: { resolveAuth: () => ({ role: 'admin', scopes: ['admin'], tenantId: TENANT, actorId: 'alice' }) },
    });
    await admin.ready();
  });

  afterAll(async () => {
    await admin?.close();
    await stop?.();
  });

  it('PUT org 级 + repo 级 → 204,密文落库;GET 只回脱敏元数据(无明文)', async () => {
    expect((await admin.inject({ method: 'PUT', url: '/v1/service-credentials', payload: { service: 'exa', apiKey: 'org-key-secret' } })).statusCode).toBe(204);
    expect((await admin.inject({ method: 'PUT', url: '/v1/service-credentials', payload: { service: 'exa', apiKey: 'repo-key-secret', repositoryId: REPO } })).statusCode).toBe(204);
    const rows = await db.selectFrom('service_credentials').selectAll().where('tenant_id', '=', TENANT).execute();
    expect(JSON.stringify(rows.map((r) => r.envelope))).not.toContain('key-secret');

    const res = await admin.inject({ method: 'GET', url: '/v1/service-credentials' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { credentials: { service: string; scope: string }[] };
    expect(body.credentials.map((c) => `${c.service}:${c.scope}`).sort()).toEqual(['exa:org', 'exa:repo']);
    expect(res.body).not.toContain('key-secret');
  });

  it('未知 service → 400;跨租户/不存在 repo → 404', async () => {
    expect((await admin.inject({ method: 'PUT', url: '/v1/service-credentials', payload: { service: 'rogue', apiKey: 'k' } })).statusCode).toBe(400);
    expect((await admin.inject({ method: 'PUT', url: '/v1/service-credentials', payload: { service: 'exa', apiKey: 'k', repositoryId: uuidv7() } })).statusCode).toBe(404);
  });

  it('DELETE repo 级 → 204,org 级保留', async () => {
    expect((await admin.inject({ method: 'DELETE', url: '/v1/service-credentials', payload: { service: 'exa', repositoryId: REPO } })).statusCode).toBe(204);
    const body = (await admin.inject({ method: 'GET', url: '/v1/service-credentials' })).json() as { credentials: { scope: string }[] };
    expect(body.credentials.map((c) => c.scope)).toEqual(['org']);
  });

  it('非 Admin(member)→ 403', async () => {
    const member = await buildServer({
      quiet: true,
      db,
      masterKey: createLocalMasterKey('k3', randomBytes(32)),
      rbac: { resolveAuth: () => ({ role: 'member', scopes: [], tenantId: TENANT, actorId: 'bob' }) },
    });
    await member.ready();
    const res = await member.inject({ method: 'PUT', url: '/v1/service-credentials', payload: { service: 'exa', apiKey: 'k' } });
    expect(res.statusCode).toBe(403);
    await member.close();
  });
describe('tenant-settings 插件开关端点(0032)', () => {
  it('PUT 合法 plugins 片段 → 保存并回显;GET 读取', async () => {
    const put = await admin.inject({ method: 'PUT', url: '/v1/tenant-settings', payload: { plugins: { exa: { enabled: false }, context7: { enabled: true } } } });
    expect(put.statusCode).toBe(200);
    const got = await admin.inject({ method: 'GET', url: '/v1/tenant-settings' });
    expect((got.json() as { settings: { plugins: Record<string, { enabled: boolean }> } }).settings.plugins).toEqual({ exa: { enabled: false }, context7: { enabled: true } });
  });

  it('未知插件名 / enabled 非布尔 → 400', async () => {
    expect((await admin.inject({ method: 'PUT', url: '/v1/tenant-settings', payload: { plugins: { rogue: { enabled: true } } } })).statusCode).toBe(400);
    expect((await admin.inject({ method: 'PUT', url: '/v1/tenant-settings', payload: { plugins: { exa: { enabled: 'yes' } } } })).statusCode).toBe(400);
  });

  it('GET /v1/plugins 注册表元数据', async () => {
    const res = await admin.inject({ method: 'GET', url: '/v1/plugins' });
    expect((res.json() as { plugins: { name: string }[] }).plugins.map((p) => p.name)).toEqual(['exa', 'context7', 'registry']);
  });
});

describe('organization configuration defaults', () => {
  it('saved defaults reach repositories that leave the value unset; plugin switches are not reset by the form', async () => {
    const before = (await admin.inject({ method: 'GET', url: '/v1/organization-config' })).json() as { settings: Record<string, unknown> };
    const form = { ...before.settings, language: 'zh', plugins: { exa: { enabled: true } } };
    expect((await admin.inject({ method: 'PUT', url: '/v1/organization-config', payload: form })).statusCode).toBe(200);
    expect((await admin.inject({ method: 'PUT', url: '/v1/organization-config', payload: { language: 42 } })).statusCode).toBe(400);

    const tenant = await db.selectFrom('tenants').select('settings').where('id', '=', TENANT).executeTakeFirstOrThrow();
    // Only what differs from the schema defaults, and the plugin switch saved through tenant-settings is kept.
    expect(tenant.settings).toEqual({ language: 'zh', plugins: { exa: { enabled: false }, context7: { enabled: true } } });
    const org = (await admin.inject({ method: 'GET', url: '/v1/organization-config' })).json() as { settings: { language: string } };
    expect(org.settings.language).toBe('zh');

    const repo = (await admin.inject({ method: 'GET', url: `/v1/repositories/${REPO}/config` })).json() as { settings: Record<string, unknown> & { language: string } };
    expect(repo.settings.language).toBe('zh');
    // Saving the repository panel with the organization's value stores no repository-level language.
    expect((await admin.inject({ method: 'PUT', url: `/v1/repositories/${REPO}/config`, payload: repo.settings })).statusCode).toBe(200);
    const panel = await db.selectFrom('repository_settings').select('panel_settings').where('repository_id', '=', REPO).executeTakeFirstOrThrow();
    expect(panel.panel_settings).not.toHaveProperty('language');
  });
});

describe('user(账户)级 self-service 凭据端点', () => {
  it('DB authz(有 userId)→ 写/读/删自己的 key;claims 模式(无 userId)→ 400', async () => {
    const USER = uuidv7();
    await db.insertInto('users').values({ id: USER, email: 'u@x.co', display_name: null, created_at: new Date() }).execute();
    const me = await buildServer({
      quiet: true,
      db: db,
      masterKey: createLocalMasterKey('k4', randomBytes(32)),
      rbac: { resolveAuth: () => ({ role: 'member', scopes: [], tenantId: TENANT, actorId: 'carol', userId: USER }) },
    });
    await me.ready();
    expect((await me.inject({ method: 'PUT', url: '/v1/my/service-credentials', payload: { service: 'context7', apiKey: 'my-c7' } })).statusCode).toBe(204);
    const list = (await me.inject({ method: 'GET', url: '/v1/my/service-credentials' })).json() as { credentials: { service: string; scope: string }[] };
    expect(list.credentials).toEqual([expect.objectContaining({ service: 'context7', scope: 'user' })]);
    expect((await me.inject({ method: 'DELETE', url: '/v1/my/service-credentials', payload: { service: 'context7' } })).statusCode).toBe(204);
    await me.close();

    const claims = await buildServer({
      quiet: true,
      db: db,
      masterKey: createLocalMasterKey('k5', randomBytes(32)),
      rbac: { resolveAuth: () => ({ role: 'member', scopes: [], tenantId: TENANT, actorId: 'dave' }) },
    });
    await claims.ready();
    expect((await claims.inject({ method: 'PUT', url: '/v1/my/service-credentials', payload: { service: 'context7', apiKey: 'x' } })).statusCode).toBe(400);
    await claims.close();
  });
});
});
