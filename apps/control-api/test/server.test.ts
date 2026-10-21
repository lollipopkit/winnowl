import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

describe('control-api', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({ quiet: true });
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  it('GET /health 返回 ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /metrics is gated by METRICS_TOKEN, not by being unreachable', async () => {
    delete process.env.METRICS_TOKEN;
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    process.env.METRICS_TOKEN = 'metrics-secret';
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: 'Bearer nope' },
        })
      ).statusCode,
    ).toBe(401);
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('process_cpu_user_seconds_total');
  });

  it('GET /v1/config/default 返回安全默认配置', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/config/default' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sandbox: { network: { mode?: string } };
      merge_gate: { enabled: boolean };
    };
    // Unset: the platform decides what network sandboxes get.
    expect(body.sandbox.network.mode).toBeUndefined();
    expect(body.merge_gate.enabled).toBe(false);
  });

  it('GET /v1/config/schema 返回 JSON Schema', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/config/schema' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('$schema');
  });

  it('生成 OpenAPI 3.1 文档', async () => {
    const doc = app.swagger();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths).toHaveProperty('/health');
  });

  it('受保护端点:默认匿名(viewer)→ 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/status' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden', permission: 'installation:manage' });
  });
});

describe('control-api RBAC / 限流', () => {
  it('admin 角色可访问受保护端点', async () => {
    const app = await buildServer({
      quiet: true,
      rbac: { resolveAuth: () => ({ role: 'admin', scopes: ['admin'] }) },
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it('固定窗口限流:超限 → 429,窗口过期恢复', async () => {
    let t = 0;
    const app = await buildServer({
      quiet: true,
      rbac: { rateLimit: { limit: 2, windowMs: 1000 }, now: () => t },
    });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(429);
    t = 2000;
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('control-api CORS (console on another origin)', () => {
  const CONSOLE = 'https://console.example.com';
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.CONSOLE_BASE_URL = CONSOLE;
    app = await buildServer({ quiet: true });
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.CONSOLE_BASE_URL;
    await app.close();
  });

  it('answers a preflight from the console origin with credentialed CORS', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: {
        origin: CONSOLE,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-tenant-id',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toContain('x-tenant-id');
  });

  it('gives a foreign origin no CORS headers and rejects its preflight', async () => {
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(pre.statusCode).toBe(403);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers.vary).toContain('Origin');
  });

  it('echoes the console origin on simple requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: CONSOLE } });
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
  });
});
