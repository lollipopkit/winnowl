import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingHttpServer } from '@reviewbot/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { initTelemetry, relayOtlpFile } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('sandbox span relay', () => {
  it('写文件 → 控制面转发到 /v1/traces,内容是 OTLP/JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spans-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'spans.json');
    const t = initTelemetry({ serviceName: 'review-executor-test', spanFile: path, simple: true });
    cleanups.push(() => t.shutdown());
    const span = t.tracer('review').startSpan('review.dig');
    span.setAttribute('review.scope', 'app');
    span.end();
    await t.forceFlush();

    const server = new RecordingHttpServer(() => ({ status: 200, body: {} }));
    cleanups.push(() => server.close());
    const relayed = await relayOtlpFile(await readFile(path, 'utf8'), await server.listen());
    expect(relayed).toEqual({ sent: 1, failed: 0, dropped: 0 });
    const req = server.requests.find((r) => r.url.endsWith('/v1/traces'))!;
    expect(JSON.stringify(req.body)).toContain('review.dig');
    expect(JSON.stringify(req.body)).toContain('review-executor-test');
  });

  it('端点不可达 / 文件损坏 → 只计数,不抛', async () => {
    expect(await relayOtlpFile('{not json', 'http://127.0.0.1:9')).toEqual({ sent: 0, failed: 0, dropped: 0 });
    expect(await relayOtlpFile(JSON.stringify({ payloads: [{}], dropped: 3 }), 'http://127.0.0.1:9', 2000)).toEqual({
      sent: 0,
      failed: 1,
      dropped: 3,
    });
  });
});
