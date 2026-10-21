import { RecordingHttpServer } from '@reviewbot/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { currentTraceCarrier, initTelemetry, withRemoteTraceCarrier, withSpan } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('initTelemetry', () => {
  it('无 OTLP 端点 → 禁用(no-op tracer,不导出)', async () => {
    const t = initTelemetry({ serviceName: 'svc' });
    expect(t.enabled).toBe(false);
    const span = t.tracer('x').startSpan('op');
    span.end();
    await t.forceFlush();
    await t.shutdown();
  });

  it('设 OTLP 端点 → span 经 OTLP/HTTP 导出到 /v1/traces', async () => {
    const server = new RecordingHttpServer(() => ({ status: 200, body: {} }));
    cleanups.push(() => server.close());
    const url = await server.listen();

    const t = initTelemetry({ serviceName: 'reviewbot-test', serviceVersion: '1.2.3', otlpEndpoint: url, simple: true });
    cleanups.push(() => t.shutdown());
    expect(t.enabled).toBe(true);

    const span = t.tracer('review-engine').startSpan('map-scope');
    span.setAttribute('scope', 'auth');
    span.end();
    await t.forceFlush();

    const traceReqs = server.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/v1/traces'));
    expect(traceReqs.length).toBeGreaterThanOrEqual(1);
    expect(traceReqs[0]!.body.length).toBeGreaterThan(0);
  });
});

describe('Langfuse 并行导出(§可观测性)', () => {
  it('主端点 + Langfuse 同时配 → 同一 span 两边都收到,且 Langfuse 侧带 Basic 认证', async () => {
    const jaeger = new RecordingHttpServer(() => ({ status: 200, body: {} }));
    const langfuse = new RecordingHttpServer(() => ({ status: 200, body: {} }));
    cleanups.push(() => jaeger.close());
    cleanups.push(() => langfuse.close());
    const [jaegerUrl, langfuseUrl] = [await jaeger.listen(), await langfuse.listen()];

    const t = initTelemetry({
      serviceName: 'dual',
      otlpEndpoint: jaegerUrl,
      langfuseEndpoint: langfuseUrl,
      langfusePublicKey: 'pk-test',
      langfuseSecretKey: 'sk-test',
      simple: true,
    });
    cleanups.push(() => t.shutdown());
    expect(t.enabled).toBe(true);

    t.tracer('agent-pi').startSpan('chat gpt-5.6-sol').end();
    await t.forceFlush();

    const at = (s: RecordingHttpServer): typeof s.requests => s.requests.filter((r) => r.url.endsWith('/v1/traces'));
    expect(at(jaeger).length).toBeGreaterThanOrEqual(1);
    expect(at(langfuse).length).toBeGreaterThanOrEqual(1);
    const auth = at(langfuse)[0]!.headers.authorization;
    expect(auth).toBe(`Basic ${Buffer.from('pk-test:sk-test').toString('base64')}`);
  });

  it('只配 Langfuse(无主端点)→ 照样启用', async () => {
    const langfuse = new RecordingHttpServer(() => ({ status: 200, body: {} }));
    cleanups.push(() => langfuse.close());
    const t = initTelemetry({
      serviceName: 'lf-only',
      langfuseEndpoint: await langfuse.listen(),
      langfusePublicKey: 'pk',
      langfuseSecretKey: 'sk',
      simple: true,
    });
    cleanups.push(() => t.shutdown());
    expect(t.enabled).toBe(true);
    t.tracer('agent-pi').startSpan('chat m').end();
    await t.forceFlush();
    expect(langfuse.requests.filter((r) => r.url.endsWith('/v1/traces')).length).toBeGreaterThanOrEqual(1);
  });

  it('密钥缺一半 → 这条链路不启用(不静默发无认证请求)', async () => {
    const langfuse = new RecordingHttpServer(() => ({ status: 200, body: {} }));
    cleanups.push(() => langfuse.close());
    const t = initTelemetry({
      serviceName: 'lf-partial',
      langfuseEndpoint: await langfuse.listen(),
      langfusePublicKey: 'pk',
      simple: true,
    });
    cleanups.push(() => t.shutdown());
    expect(t.enabled).toBe(false);
  });
});

describe('trace context 跨 job 传播(§41)', () => {
  it('启用后:active span 内取到载体,远端以它为父 → 同一 traceId', async () => {
    const server = new RecordingHttpServer(() => ({ status: 200, body: {} }));
    cleanups.push(() => server.close());
    const t = initTelemetry({ serviceName: 'carrier-test', otlpEndpoint: await server.listen(), simple: true });
    cleanups.push(() => t.shutdown());

    let carrier: Record<string, string> | undefined;
    let producerTraceId = '';
    await withSpan(t.tracer('webhook'), 'webhook.receive', async (span) => {
      producerTraceId = span.spanContext().traceId;
      carrier = currentTraceCarrier();
    });
    expect(carrier?.traceparent).toContain(producerTraceId);

    let consumerTraceId = '';
    await withRemoteTraceCarrier(carrier, () =>
      withSpan(t.tracer('runner'), 'job.review_revision', async (span) => {
        consumerTraceId = span.spanContext().traceId;
      }),
    );
    expect(consumerTraceId).toBe(producerTraceId);
  });

  it('载体缺失/空 → 原样执行(不因遥测影响业务路径)', async () => {
    let ran = false;
    await withRemoteTraceCarrier(undefined, async () => { ran = true; });
    expect(ran).toBe(true);
    await withRemoteTraceCarrier({}, async () => { ran = true; });
    expect(ran).toBe(true);
  });
});

describe('withSpan(§41.2)', () => {
  it('返回 fn 结果并导出 span(含 attribute)', async () => {
    const server = new RecordingHttpServer(() => ({ status: 200, body: {} }));
    cleanups.push(() => server.close());
    const url = await server.listen();
    const t = initTelemetry({ serviceName: 'svc', otlpEndpoint: url, simple: true });
    cleanups.push(() => t.shutdown());

    const result = await withSpan(t.tracer('runner'), 'job.review', async (span) => {
      span.setAttribute('job.type', 'review_revision');
      return 42;
    });
    expect(result).toBe(42);
    await t.forceFlush();
    expect(server.requests.filter((r) => r.url.endsWith('/v1/traces')).length).toBeGreaterThanOrEqual(1);
  });

  it('fn 抛错 → 重抛且仍 end span(导出 error span)', async () => {
    const server = new RecordingHttpServer(() => ({ status: 200, body: {} }));
    cleanups.push(() => server.close());
    const url = await server.listen();
    const t = initTelemetry({ serviceName: 'svc', otlpEndpoint: url, simple: true });
    cleanups.push(() => t.shutdown());

    await expect(
      withSpan(t.tracer('x'), 'op', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await t.forceFlush();
    expect(server.requests.filter((r) => r.url.endsWith('/v1/traces')).length).toBeGreaterThanOrEqual(1);
  });

  it('telemetry 禁用(no-op tracer)→ 仍执行 fn 返回结果', async () => {
    const t = initTelemetry({ serviceName: 'svc' });
    expect(t.enabled).toBe(false);
    const result = await withSpan(t.tracer('x'), 'op', async () => 'ok');
    expect(result).toBe('ok');
  });
});

describe('metrics(§41.1 Prometheus)', () => {
  it('record* → /metrics 文本含对应指标', async () => {
    const { initMetrics, metricsText, recordJob, recordReview, recordPluginCall } = await import('../src/index.js');
    initMetrics('svc-test');
    recordJob('review_revision', 'completed', 12.5);
    recordJob('review_revision', 'failed', 1);
    recordReview('approve');
    recordPluginCall('exa', 'web_search', 'platform');
    const text = await metricsText();
    expect(text).toContain('winnowl_jobs_total');
    expect(text).toContain('type="review_revision"');
    expect(text).toContain('outcome="completed"');
    expect(text).toContain('winnowl_job_duration_seconds');
    expect(text).toContain('winnowl_reviews_total');
    expect(text).toContain('event="approve"');
    expect(text).toContain('winnowl_plugin_calls_total');
    expect(text).toContain('plugin="exa"');
    expect(text).toContain('process_cpu');
  });
});
