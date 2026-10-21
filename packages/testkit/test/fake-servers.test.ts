import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelServer, FakeProviderServer } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

describe('FakeModelServer', () => {
  it('按队列返回回复并记录请求', async () => {
    const server = new FakeModelServer();
    cleanups.push(() => server.close());
    const url = await server.listen();
    server.enqueue({ text: 'first' }, { text: 'second' });

    const r1 = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hi' }),
    });
    const j1 = (await r1.json()) as { content: string };
    expect(j1.content).toBe('first');

    const r2 = await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' });
    const j2 = (await r2.json()) as { content: string };
    expect(j2.content).toBe('second');

    // queue exhausted -> default reply
    const r3 = await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' });
    const j3 = (await r3.json()) as { content: string };
    expect(j3.content).toBe('ok');

    expect(server.requests).toHaveLength(3);
    expect(server.requests[0]?.json()).toEqual({ prompt: 'hi' });
  });
});

describe('FakeProviderServer', () => {
  it('按 method+前缀路由,未匹配返回 404', async () => {
    const server = new FakeProviderServer();
    cleanups.push(() => server.close());
    server.on('POST', '/repos/', { status: 201, body: { id: 'c1' } });
    const url = await server.listen();

    const created = await fetch(`${url}/repos/acme/app/comments`, { method: 'POST', body: '{}' });
    expect(created.status).toBe(201);
    expect((await created.json()) as { id: string }).toEqual({ id: 'c1' });

    const missing = await fetch(`${url}/unknown`, { method: 'GET' });
    expect(missing.status).toBe(404);
  });
});
