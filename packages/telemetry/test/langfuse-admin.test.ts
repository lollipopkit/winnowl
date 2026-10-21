import { RecordingHttpServer } from '@reviewbot/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { LangfuseAdminClient, langfuseAdminFromEnv } from '../src/langfuse-admin.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fakeLangfuse(pages: Record<string, { data: { traceId: string }[]; meta?: { cursor?: string } }>) {
  const deleted: string[][] = [];
  const server = new RecordingHttpServer((req) => {
    if (req.method === 'DELETE') {
      deleted.push((req.json() as { traceIds: string[] }).traceIds);
      return { status: 200, body: { message: 'Traces deleted successfully' } };
    }
    const url = new URL(req.url, 'http://localhost');
    const filter = JSON.parse(url.searchParams.get('filter') ?? '[]') as { key: string; value: string }[];
    const cursor = url.searchParams.get('cursor');
    const key = `${filter[0]?.key}=${filter[0]?.value}${cursor ? `@${cursor}` : ''}`;
    return { status: 200, body: pages[key] ?? { data: [], meta: {} } };
  });
  const baseUrl = await server.listen();
  cleanups.push(() => server.close());
  return { server, baseUrl, deleted };
}

describe('LangfuseAdminClient(§43 ③ 擦除扩到 Langfuse)', () => {
  it('按 metadata 筛 observation → 去重成 traceId → 批量删 trace', async () => {
    const { server, baseUrl, deleted } = await fakeLangfuse({
      // Several observations of one trace must delete it once.
      'installation=inst-1': { data: [{ traceId: 't1' }, { traceId: 't1' }, { traceId: 't2' }], meta: {} },
    });
    const client = new LangfuseAdminClient({ baseUrl, publicKey: 'pk', secretKey: 'sk' });

    expect(await client.eraseByMetadata([{ key: 'installation', value: 'inst-1' }])).toBe(2);

    const list = server.requests.find((r) => r.method === 'GET')!;
    const listUrl = new URL(list.url, 'http://localhost');
    expect(listUrl.pathname).toBe('/api/public/v2/observations');
    expect(JSON.parse(listUrl.searchParams.get('filter')!)).toEqual([
      { type: 'stringObject', column: 'metadata', key: 'installation', operator: '=', value: 'inst-1' },
    ]);
    expect(list.headers.authorization).toBe(`Basic ${Buffer.from('pk:sk').toString('base64')}`);
    expect(deleted).toEqual([['t1', 't2']]);
  });

  it('cursor 分页走到底;多个条件取并集', async () => {
    const { baseUrl, deleted } = await fakeLangfuse({
      'installation=inst-1': { data: [{ traceId: 't1' }], meta: { cursor: 'c2' } },
      'installation=inst-1@c2': { data: [{ traceId: 't2' }], meta: {} },
      // Overlaps the installation match; must not delete twice.
      'repo=acme/app': { data: [{ traceId: 't2' }, { traceId: 't3' }], meta: {} },
    });
    const client = new LangfuseAdminClient({ baseUrl, publicKey: 'pk', secretKey: 'sk' });

    const count = await client.eraseByMetadata([
      { key: 'installation', value: 'inst-1' },
      { key: 'repo', value: 'acme/app' },
    ]);

    expect(count).toBe(3);
    expect(deleted).toEqual([['t1', 't2', 't3']]);
  });

  it('一条都没命中 → 不发删除请求', async () => {
    const { baseUrl, deleted } = await fakeLangfuse({});
    const client = new LangfuseAdminClient({ baseUrl, publicKey: 'pk', secretKey: 'sk' });
    expect(await client.eraseByMetadata([{ key: 'installation', value: 'inst-x' }])).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('HTTP 出错即抛(交给 Job 重试),不静默当成擦干净了', async () => {
    const server = new RecordingHttpServer(() => ({ status: 503, body: { message: 'upstream down' } }));
    const baseUrl = await server.listen();
    cleanups.push(() => server.close());
    const client = new LangfuseAdminClient({ baseUrl, publicKey: 'pk', secretKey: 'sk' });
    await expect(client.eraseByMetadata([{ key: 'installation', value: 'inst-1' }])).rejects.toThrow(/HTTP 503/);
  });

  it('cursor 不推进 → 报错而不是无限翻页', async () => {
    const { baseUrl } = await fakeLangfuse({
      'installation=inst-1': { data: [{ traceId: 't1' }], meta: { cursor: 'stuck' } },
      'installation=inst-1@stuck': { data: [{ traceId: 't1' }], meta: { cursor: 'stuck' } },
    });
    const client = new LangfuseAdminClient({ baseUrl, publicKey: 'pk', secretKey: 'sk' });
    await expect(client.eraseByMetadata([{ key: 'installation', value: 'inst-1' }])).rejects.toThrow(/cursor did not advance/);
  });
});

describe('langfuseAdminFromEnv(配置三态)', () => {
  it('Langfuse 没配 → undefined(那边没有 trace,无可擦)', () => {
    expect(langfuseAdminFromEnv({})).toBeUndefined();
    expect(langfuseAdminFromEnv({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' })).toBeUndefined();
  });

  it('从 OTLP 端点推出站点根', async () => {
    const { server, baseUrl, deleted } = await fakeLangfuse({ 'installation=i': { data: [{ traceId: 't' }], meta: {} } });
    const client = langfuseAdminFromEnv({
      LANGFUSE_OTLP_ENDPOINT: `${baseUrl}/api/public/otel`,
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
    })!;
    await client.eraseByMetadata([{ key: 'installation', value: 'i' }]);
    expect(new URL(server.requests[0]!.url, 'http://x').pathname).toBe('/api/public/v2/observations');
    expect(deleted).toEqual([['t']]);
  });

  it('配了 Langfuse 但推不出站点根 → 抛,不返回 undefined', () => {
    expect(() =>
      langfuseAdminFromEnv({
        LANGFUSE_OTLP_ENDPOINT: 'https://lf.example.com/otel-ingest',
        LANGFUSE_PUBLIC_KEY: 'pk',
        LANGFUSE_SECRET_KEY: 'sk',
      }),
    ).toThrow(/LANGFUSE_BASE_URL/);
  });

  it('LANGFUSE_BASE_URL 显式覆盖推导', async () => {
    const { server, baseUrl } = await fakeLangfuse({ 'installation=i': { data: [], meta: {} } });
    const client = langfuseAdminFromEnv({
      LANGFUSE_OTLP_ENDPOINT: 'https://ingest.invalid/otel-ingest',
      LANGFUSE_BASE_URL: baseUrl,
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
    })!;
    await client.eraseByMetadata([{ key: 'installation', value: 'i' }]);
    expect(server.requests).toHaveLength(1);
  });
});
