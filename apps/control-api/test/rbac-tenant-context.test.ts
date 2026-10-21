import { currentTenantId } from '@reviewbot/db';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidTokenError, registerRbac, requirePermission, type AuthContext } from '../src/rbac.js';

/** The onRequest hook must bind the tenant for the rest of the request; RLS itself is covered in tenant-isolation.integration.test.ts. */
const TENANT = '018f0000-0000-7000-8000-000000000001';

describe('control-api 租户上下文绑定(rbac onRequest)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const build = async (resolveAuth?: (req: FastifyRequest) => AuthContext): Promise<FastifyInstance> => {
    const instance = Fastify();
    registerRbac(instance, resolveAuth ? { resolveAuth } : {});
    // Async preHandler like requirePermission; read the tenant before and after an await.
    instance.get('/tenant', { preHandler: requirePermission('review:read') }, async () => {
      const atEntry = currentTenantId();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { atEntry, afterAwait: currentTenantId() };
    });
    instance.get('/admin-only', { preHandler: requirePermission('member:manage') }, async () => ({
      ok: true,
    }));
    await instance.ready();
    return instance;
  };

  it('handler 在入场与 await 之后都看得到 auth 的租户', async () => {
    app = await build(() => ({ role: 'admin', scopes: ['admin'], tenantId: TENANT }));
    const res = await app.inject({ method: 'GET', url: '/tenant' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ atEntry: TENANT, afterAwait: TENANT });
  });

  it('匿名请求(无租户) → null,不是上一个请求的残留', async () => {
    let tenantId: string | undefined = TENANT;
    app = await build(() => ({ role: 'viewer', scopes: [], ...(tenantId ? { tenantId } : {}) }));
    expect((await app.inject({ method: 'GET', url: '/tenant' })).json()).toEqual({
      atEntry: TENANT,
      afterAwait: TENANT,
    });
    tenantId = undefined;
    expect((await app.inject({ method: 'GET', url: '/tenant' })).json()).toEqual({
      atEntry: null,
      afterAwait: null,
    });
  });

  it('请求结束后上下文不残留(不会漏给同一进程里的其它异步工作)', async () => {
    app = await build(() => ({ role: 'admin', scopes: ['admin'], tenantId: TENANT }));
    await app.inject({ method: 'GET', url: '/tenant' });
    expect(currentTenantId()).toBeNull();
  });

  it('InvalidTokenError 仍回 401', async () => {
    app = await build(() => {
      throw new InvalidTokenError();
    });
    const res = await app.inject({ method: 'GET', url: '/tenant' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_token' });
  });

  it('权限不足仍回 403(限流之外的行为不变)', async () => {
    app = await build(() => ({ role: 'viewer', scopes: [] }));
    const res = await app.inject({ method: 'GET', url: '/admin-only' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden', permission: 'member:manage' });
  });

  it('限流仍生效:超限 → 429,窗口过期恢复', async () => {
    let now = 0;
    const limited = Fastify();
    // Rate limiting must run after the async identity resolution.
    registerRbac(limited, {
      resolveAuth: async (): Promise<AuthContext> => ({ role: 'viewer', scopes: [] }),
      rateLimit: { limit: 1, windowMs: 1000 },
      now: () => now,
    });
    limited.get('/ping', async () => ({ ok: true }));
    await limited.ready();
    app = limited;
    expect((await limited.inject({ method: 'GET', url: '/ping' })).statusCode).toBe(200);
    expect((await limited.inject({ method: 'GET', url: '/ping' })).statusCode).toBe(429);
    now = 2000;
    expect((await limited.inject({ method: 'GET', url: '/ping' })).statusCode).toBe(200);
  });
});
