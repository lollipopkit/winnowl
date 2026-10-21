import { RecordingHttpServer } from '@reviewbot/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { initTelemetry } from '../src/index.js';
import { toOtlpJson } from '../src/fetch-otlp-exporter.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('FetchOtlpSpanExporter(§可观测性)', () => {
  it('span 经 fetch 发到 /v1/traces,带 Basic 认证与 OTLP 结构', async () => {
    const server = new RecordingHttpServer(() => ({ status: 200, body: {} }));
    cleanups.push(() => server.close());
    const t = initTelemetry({
      serviceName: 'exporter-test',
      langfuseEndpoint: await server.listen(),
      langfusePublicKey: 'pk',
      langfuseSecretKey: 'sk',
      simple: true,
    });
    cleanups.push(() => t.shutdown());

    const span = t.tracer('agent-pi').startSpan('chat m');
    span.setAttribute('gen_ai.request.model', 'gpt-5.6-sol');
    span.setAttribute('gen_ai.usage.input_tokens', 100);
    span.setAttribute('gen_ai.usage.cost', 0.0123);
    span.setAttribute('langfuse.trace.tags', ['review']);
    span.end();
    await t.forceFlush();

    const req = server.requests.find((r) => r.url.endsWith('/v1/traces'));
    expect(req).toBeDefined();
    expect(req!.headers.authorization).toBe(`Basic ${Buffer.from('pk:sk').toString('base64')}`);
    expect(req!.headers['content-type']).toContain('application/json');

    const payload = req!.json() as { resourceSpans: Array<Record<string, unknown>> };
    const scopeSpans = payload.resourceSpans[0]!.scopeSpans as Array<Record<string, unknown>>;
    const sent = (scopeSpans[0]!.spans as Array<Record<string, unknown>>)[0]!;
    expect(sent.name).toBe('chat m');
    // OTLP JSON expects hex ids, not base64 or uuids.
    expect(String(sent.traceId)).toMatch(/^[0-9a-f]{32}$/);
    expect(String(sent.spanId)).toMatch(/^[0-9a-f]{16}$/);
    // Nanosecond strings; anything else lands the span in 1970.
    expect(String(sent.startTimeUnixNano)).toMatch(/^\d{19}$/);
    expect(scopeSpans[0]!.scope).toMatchObject({ name: 'agent-pi' });
  });

  it('属性按类型编码:整数 intValue(字符串)、小数 doubleValue、数组 arrayValue', () => {
    const fake = [
      {
        spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
        name: 'x',
        kind: 0,
        startTime: [1, 2] as [number, number],
        endTime: [3, 4] as [number, number],
        attributes: { i: 100, d: 0.5, s: 'str', b: true, arr: ['p', 'q'] },
        status: { code: 1 },
        resource: { attributes: { 'service.name': 'svc' } },
        instrumentationLibrary: { name: 'agent-pi' },
      },
    ];
    const out = toOtlpJson(fake as any);
    const attrs = ((out.resourceSpans as any[])[0].scopeSpans[0].spans[0].attributes as Array<{ key: string; value: Record<string, unknown> }>);
    const by = Object.fromEntries(attrs.map((a) => [a.key, a.value]));
    // int64 is a string in OTLP JSON; Langfuse rejects numbers.
    expect(by.i).toEqual({ intValue: '100' });
    expect(by.d).toEqual({ doubleValue: 0.5 });
    expect(by.s).toEqual({ stringValue: 'str' });
    expect(by.b).toEqual({ boolValue: true });
    expect(by.arr).toEqual({ arrayValue: { values: [{ stringValue: 'p' }, { stringValue: 'q' }] } });
    // OTel SpanKind starts at 0, OTLP INTERNAL is 1.
    expect((out.resourceSpans as any[])[0].scopeSpans[0].spans[0].kind).toBe(1);
  });

  it('hrTime → 纳秒:秒与纳秒分量都要算进去', () => {
    const fake = [
      {
        spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
        name: 'x',
        kind: 0,
        startTime: [1700000000, 123456789] as [number, number],
        endTime: [1700000001, 0] as [number, number],
        attributes: {},
        status: { code: 0 },
        resource: { attributes: {} },
        instrumentationLibrary: { name: 's' },
      },
    ];
    const span = (toOtlpJson(fake as any).resourceSpans as any[])[0].scopeSpans[0].spans[0];
    expect(span.startTimeUnixNano).toBe('1700000000123456789');
    expect(span.endTimeUnixNano).toBe('1700000001000000000');
  });

  it('导出失败不抛(遥测不该把业务带崩)', async () => {
    const server = new RecordingHttpServer(() => ({ status: 500, body: {} }));
    cleanups.push(() => server.close());
    const t = initTelemetry({
      serviceName: 'fail-test',
      langfuseEndpoint: await server.listen(),
      langfusePublicKey: 'pk',
      langfuseSecretKey: 'sk',
      simple: true,
    });
    cleanups.push(() => t.shutdown());
    t.tracer('x').startSpan('op').end();
    await expect(t.forceFlush()).resolves.toBeUndefined();
  });
});
