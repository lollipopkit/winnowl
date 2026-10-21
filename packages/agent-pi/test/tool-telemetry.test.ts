import { RecordingHttpServer } from '@reviewbot/testkit';
import { initTelemetry, withSpan, type TelemetryHandle } from '@reviewbot/telemetry';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { observeBlockedToolCall, observeToolCall } from '../src/tool-telemetry.js';

interface OtlpSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status: { code: number; message?: string };
}

// The global tracer provider can be registered once per process, so the collector is shared and reset per test.
let server: RecordingHttpServer;
let telemetry: TelemetryHandle;

const spans = (): OtlpSpan[] =>
  server.requests.flatMap((r) => {
    const payload = r.json() as { resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[] };
    return (payload.resourceSpans ?? []).flatMap((rs) => (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []));
  });

beforeAll(async () => {
  server = new RecordingHttpServer(() => ({ status: 200, body: {} }));
  const endpoint = await server.listen();
  telemetry = initTelemetry({
    serviceName: 'tool-telemetry-test',
    langfuseEndpoint: endpoint,
    langfusePublicKey: 'pk',
    langfuseSecretKey: 'sk',
    simple: true,
  });
});

beforeEach(() => {
  server.requests.length = 0;
});

afterAll(async () => {
  await telemetry.shutdown();
  await server.close();
});

const attrsOf = (span: OtlpSpan): Record<string, unknown> =>
  Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));

describe('工具调用埋点(§可观测性 ④)', () => {
  it('走 OTel gen_ai 约定标成工具调用,输出摘要入 span', async () => {
    observeToolCall('read_file').settle({ outputBytes: 1234, truncated: false, isError: false });
    await telemetry.forceFlush();

    const span = spans().find((s) => s.name === 'execute_tool read_file');
    expect(span).toBeDefined();
    // Langfuse treats this as TOOL and displays gen_ai.tool.name.
    expect(attrsOf(span!)).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'read_file',
      'tool.output_bytes': '1234',
    });
    // Arguments and output are customer source code and must not be recorded.
    expect(Object.keys(attrsOf(span!)).some((k) => k.includes('arguments') || k.includes('output_text'))).toBe(false);
  });

  it('与 stage span 构成父子(review → stage → tool),而不是挂在 generation 下', async () => {
    await withSpan(telemetry.tracer('review-orchestrator'), 'review.dig', async () => {
      observeToolCall('grep').settle({ outputBytes: 10 });
    });
    await telemetry.forceFlush();

    const all = spans();
    const stage = all.find((s) => s.name === 'review.dig');
    const tool = all.find((s) => s.name === 'execute_tool grep');
    expect(stage).toBeDefined();
    expect(tool?.parentSpanId).toBe(stage!.spanId);
  });

  it('工具报错 → span 置 ERROR(截断也记,但不算错)', async () => {
    observeToolCall('run_tests').settle({ outputBytes: 900_000, truncated: true, isError: true });
    await telemetry.forceFlush();

    const span = spans().find((s) => s.name === 'execute_tool run_tests')!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(attrsOf(span)['tool.truncated']).toBe(true);
  });

  it('被挡下的调用一次性记完即关 —— pi 不会再调 afterToolCall,借用 start/settle 会让 span 永远悬着', async () => {
    observeBlockedToolCall('write_file', 'not-permitted');
    observeBlockedToolCall('read_file', 'budget-exhausted');
    await telemetry.forceFlush();

    const blocked = spans().filter((s) => s.name.startsWith('execute_tool '));
    // Both must be exported: spans that never end are not exported.
    expect(blocked).toHaveLength(2);
    expect(blocked.map((s) => attrsOf(s)['tool.blocked_reason']).sort()).toEqual(['budget-exhausted', 'not-permitted']);
    expect(blocked.every((s) => s.status.code === 2)).toBe(true);
  });

  it('重复 settle 只记一次(异常路径会走到)', async () => {
    const call = observeToolCall('read_file');
    call.settle({ outputBytes: 1 });
    call.settle({ outputBytes: 2, isError: true });
    await telemetry.forceFlush();

    const found = spans().filter((s) => s.name === 'execute_tool read_file');
    expect(found).toHaveLength(1);
    expect(attrsOf(found[0]!)['tool.output_bytes']).toBe('1');
  });
});
