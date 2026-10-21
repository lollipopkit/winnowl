import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

/**
 * OTLP/HTTP JSON span exporter on `fetch`. The official exporter creates its own https.Agent, which
 * ignores the env proxy, so inside a sandbox (squid is the only way out) spans were silently lost.
 * fetch uses undici and honours the executor's global ProxyAgent.
 */
export class FetchOtlpSpanExporter implements SpanExporter {
  private shuttingDown = false;
  /** Tracked so forceFlush waits for them; the executor exits right after flushing. */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly timeoutMs = 15_000,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.shuttingDown || spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    const body = JSON.stringify(toOtlpJson(spans));
    // Without a timeout a hung endpoint would hang forceFlush and the executor's exit.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    const pending = fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body,
      signal: abort.signal,
    })
      .then((res) =>
        res.ok
          ? { code: ExportResultCode.SUCCESS }
          : { code: ExportResultCode.FAILED, error: new Error(`OTLP export HTTP ${res.status}`) },
      )
      .catch((error: unknown) => ({ code: ExportResultCode.FAILED, error: error as Error }))
      .then((result) => {
        clearTimeout(timer);
        this.inFlight.delete(pending);
        // Never throw: telemetry failures must not affect the caller.
        resultCallback(result as ExportResult);
      });
    this.inFlight.add(pending);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.forceFlush();
  }

  async forceFlush(): Promise<void> {
    while (this.inFlight.size > 0) {
      // New batches may be queued while waiting.
      await Promise.allSettled([...this.inFlight]);
    }
  }
}

function anyValue(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  return { stringValue: String(v) };
}

function kvList(attrs: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  return Object.entries(attrs ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

function hrToNanos(t: [number, number] | undefined): string {
  if (!t) return '0';
  return String(BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]));
}

/** Groups by scope and assumes one resource per batch. */
export function toOtlpJson(spans: ReadableSpan[]): Record<string, unknown> {
  const byScope = new Map<string, ReadableSpan[]>();
  for (const s of spans) {
    const key = `${s.instrumentationLibrary?.name ?? ''}@${s.instrumentationLibrary?.version ?? ''}`;
    const list = byScope.get(key);
    if (list) list.push(s);
    else byScope.set(key, [s]);
  }
  const first = spans[0]!;
  return {
    resourceSpans: [
      {
        resource: { attributes: kvList(first.resource?.attributes as Record<string, unknown>) },
        scopeSpans: [...byScope.values()].map((group) => {
          const lib = group[0]!.instrumentationLibrary;
          return {
            scope: { name: lib?.name ?? 'unknown', ...(lib?.version ? { version: lib.version } : {}) },
            spans: group.map((s) => {
              const ctx = s.spanContext();
              return {
                traceId: ctx.traceId,
                spanId: ctx.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: s.kind + 1, // OTel SpanKind starts at 0; OTLP SPAN_KIND_INTERNAL is 1
                startTimeUnixNano: hrToNanos(s.startTime),
                endTimeUnixNano: hrToNanos(s.endTime),
                attributes: kvList(s.attributes as Record<string, unknown>),
                status: {
                  code: s.status.code,
                  ...(s.status.message ? { message: s.status.message } : {}),
                },
              };
            }),
          };
        }),
      },
    ],
  };
}
