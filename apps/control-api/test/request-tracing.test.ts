import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from '@opentelemetry/api';
import { currentTraceCarrier, initTelemetry, type TelemetryHandle } from '@reviewbot/telemetry';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerRequestTracing } from '../src/request-tracing.js';

interface ExportedSpan {
  traceId: string;
  name: string;
  attributes: { key: string; value: { intValue?: string; stringValue?: string } }[];
}

describe('request tracing', () => {
  let dir: string;
  let spanFile: string;
  let telemetry: TelemetryHandle;
  let app: FastifyInstance;
  let base: string;

  const exported = (): ExportedSpan[] => {
    const file = JSON.parse(readFileSync(spanFile, 'utf8')) as {
      payloads: { resourceSpans: { scopeSpans: { spans: ExportedSpan[] }[] }[] }[];
    };
    return file.payloads.flatMap((p) => p.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'request-tracing-'));
    spanFile = join(dir, 'spans.json');
    telemetry = initTelemetry({ serviceName: 'control-api-test', spanFile, simple: true });
    app = Fastify();
    registerRequestTracing(app, trace.getTracer('test'));
    // An async hook after ours, like rbac's session lookup: the context must survive it.
    app.addHook('preHandler', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    app.post('/things/:id', async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { carrier: currentTraceCarrier() ?? null, body: request.body };
    });
    app.get('/things', async () => ({ carrier: currentTraceCarrier() ?? null }));
    app.post('/boom', async () => {
      throw new Error('boom');
    });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await app.close();
    await telemetry.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a write handler inside a server span, so jobs it enqueues join that trace', async () => {
    const res = await fetch(`${base}/things/7`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    const json = (await res.json()) as { carrier: { traceparent: string } | null; body: unknown };
    expect(json.body).toEqual({ a: 1 });
    expect(json.carrier?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const traceId = json.carrier!.traceparent.split('-')[1];

    await telemetry.forceFlush();
    const span = exported().find((s) => s.name === 'POST /things/:id');
    expect(span?.traceId).toBe(traceId);
    expect(span?.attributes).toContainEqual({ key: 'http.response.status_code', value: { intValue: '200' } });
  });

  it('leaves reads untraced', async () => {
    const json = (await (await fetch(`${base}/things`)).json()) as { carrier: unknown };
    expect(json.carrier).toBeNull();
    await telemetry.forceFlush();
    expect(exported().some((s) => s.name.startsWith('GET'))).toBe(false);
  });

  it('marks a failed request', async () => {
    const res = await fetch(`${base}/boom`, { method: 'POST' });
    expect(res.status).toBe(500);
    await telemetry.forceFlush();
    expect(exported().some((s) => s.name === 'POST /boom')).toBe(true);
  });
});
