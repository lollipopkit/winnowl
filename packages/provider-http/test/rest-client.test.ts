import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from '@reviewbot/provider-contracts';
import { RecordingHttpServer } from '@reviewbot/testkit';
import { RestClient, readRateLimit } from '../src/index.js';

const servers: RecordingHttpServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()?.close();
});

async function startServer(): Promise<{ server: RecordingHttpServer; url: string }> {
  const server = new RecordingHttpServer();
  servers.push(server);
  const url = await server.listen();
  return { server, url };
}

describe('readRateLimit', () => {
  it('解析 GitHub 与 GitLab 两种头', () => {
    const gh = new Headers({ 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '1700000000' });
    expect(readRateLimit(gh)).toEqual({ limit: 5000, remaining: 42, resetAt: 1700000000 });
    const gl = new Headers({ 'ratelimit-remaining': '10' });
    expect(readRateLimit(gl)).toEqual({ remaining: 10 });
  });
});

describe('RestClient', () => {
  it('读取响应中的 rate-limit 并暴露', async () => {
    const { server, url } = await startServer();
    server.setResponder(() => ({ status: 200, headers: { 'x-ratelimit-remaining': '7' }, body: { ok: true } }));
    const client = new RestClient({ baseUrl: url });
    const res = await client.get<{ ok: boolean }>('anything');
    expect(res.data.ok).toBe(true);
    expect(client.rateLimit.remaining).toBe(7);
  });

  it('429 后退避重试并最终成功', async () => {
    const { server, url } = await startServer();
    server.setResponder(() => (server.requests.length < 2 ? { status: 429, body: {} } : { status: 200, body: { ok: 1 } }));
    const client = new RestClient({ baseUrl: url, maxRetries: 3 });
    const res = await client.get<{ ok: number }>('x');
    expect(res.data.ok).toBe(1);
    expect(server.requests.length).toBe(2);
  });

  it('5xx 重试耗尽后抛 retryable ProviderError', async () => {
    const { server, url } = await startServer();
    server.setResponder(() => ({ status: 500, body: { error: 'boom' } }));
    const client = new RestClient({ baseUrl: url, maxRetries: 2 });
    await expect(client.get('x')).rejects.toMatchObject({ status: 500, retryable: true });
    expect(server.requests.length).toBe(3); // 1 + 2 retries
  });

  it('4xx 不重试,映射为不可重试 ProviderError', async () => {
    const { server, url } = await startServer();
    server.setResponder(() => ({ status: 404, body: { message: 'nope' } }));
    const client = new RestClient({ baseUrl: url });
    let caught: unknown;
    try {
      await client.get('x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).status).toBe(404);
    expect((caught as ProviderError).retryable).toBe(false);
    expect(server.requests.length).toBe(1);
  });

  it('getAllPages follows rel="next" by page number only, never the linked host', async () => {
    const { server, url } = await startServer();
    server.setResponder((req) => {
      const page = new URL(req.url, 'http://x').searchParams.get('page') ?? '1';
      // next points at another host: only its page is used, the request still goes to baseUrl.
      const link =
        page === '1'
          ? '<https://evil.example/repos/x/files?per_page=2&page=2>; rel="next", <https://evil.example/x?page=3>; rel="last"'
          : page === '2'
            ? `<${url}/files?per_page=2&page=3>; rel="next"`
            : undefined;
      return { status: 200, ...(link ? { headers: { link } } : {}), body: [`${page}a`, `${page}b`] };
    });
    const client = new RestClient({ baseUrl: url });
    expect(await client.getAllPages<string>('files', { query: { per_page: 2 } })).toEqual([
      '1a', '1b', '2a', '2b', '3a', '3b',
    ]);
    expect(server.requests.map((r) => r.url)).toEqual([
      '/files?per_page=2',
      '/files?per_page=2&page=2',
      '/files?per_page=2&page=3',
    ]);
  });

  it('getAllPages throws instead of silently truncating past maxPages', async () => {
    const { server, url } = await startServer();
    server.setResponder(() => ({ status: 200, headers: { link: `<${url}/x?page=2>; rel="next"` }, body: [1] }));
    const client = new RestClient({ baseUrl: url });
    await expect(client.getAllPages('x', {}, 3)).rejects.toThrow(/more than 3 pages/);
    expect(server.requests.length).toBe(3);
  });

  it('注入 authorization 头', async () => {
    const { server, url } = await startServer();
    server.setResponder(() => ({ status: 200, body: {} }));
    const client = new RestClient({ baseUrl: url, authorization: () => 'Bearer tkn' });
    await client.get('x');
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer tkn');
  });
});
