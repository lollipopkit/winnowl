import { renameSync, writeFileSync } from 'node:fs';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { toOtlpJson } from './fetch-otlp-exporter.js';

/**
 * Writes spans as OTLP/JSON to a file the control plane relays (`relayOtlpFile`), since sandboxes
 * cannot reach the private collector. Content is `{ payloads, dropped }`, rewritten atomically via
 * rename; spans beyond maxBytes are only counted.
 */
export class FileOtlpSpanExporter implements SpanExporter {
  private readonly payloads: Record<string, unknown>[] = [];
  private bytes = 0;
  private dropped = 0;

  constructor(
    private readonly path: string,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    const payload = toOtlpJson(spans);
    const size = JSON.stringify(payload).length;
    if (this.bytes + size > this.maxBytes) this.dropped += spans.length;
    else {
      this.payloads.push(payload);
      this.bytes += size;
    }
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ payloads: this.payloads, dropped: this.dropped }), 'utf8');
      renameSync(tmp, this.path);
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Never throws: parse or network failures only show up in the counts. */
export async function relayOtlpFile(
  content: string,
  endpoint: string,
  timeoutMs = 15_000,
  /** Extra request headers, e.g. Langfuse's Basic authorization. */
  headers: Record<string, string> = {},
): Promise<{ sent: number; failed: number; dropped: number }> {
  let parsed: { payloads?: unknown[]; dropped?: number };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return { sent: 0, failed: 0, dropped: 0 };
  }
  const url = `${endpoint.replace(/\/$/, '')}/v1/traces`;
  let sent = 0;
  let failed = 0;
  for (const payload of parsed.payloads ?? []) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });
      if (res.ok) sent += 1;
      else failed += 1;
    } catch {
      failed += 1;
    } finally {
      clearTimeout(timer);
    }
  }
  return { sent, failed, dropped: parsed.dropped ?? 0 };
}
