/**
 * Langfuse admin client for installation erasure (prompts may contain customer code).
 *
 * Langfuse v4 events_only mode removed `GET /api/public/traces`, so trace ids are collected from
 * `GET /api/public/v2/observations` and deleted via `DELETE /api/public/traces`. A trace never spans
 * installations, so deleting by trace is safe. Deletion is asynchronous: counts are "requested".
 */

export interface LangfuseMetadataMatch {
  key: string;
  value: string;
}

export interface LangfuseTraceEraser {
  /** Deletes traces matching any condition; returns the number of traces requested for deletion. */
  eraseByMetadata(matches: LangfuseMetadataMatch[]): Promise<number>;
}

export interface LangfuseAdminConfig {
  /** Site root, without `/api/public`. */
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** API maximum. */
const PAGE_LIMIT = 1000;
/** Exceeding this fails (and retries) instead of silently erasing only part. */
const MAX_PAGES = 500;
const DELETE_BATCH = 500;

interface ObservationPage {
  data?: { traceId?: string | null }[];
  meta?: { cursor?: string | null };
}

export class LangfuseAdminClient implements LangfuseTraceEraser {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: LangfuseAdminConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64')}`;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async eraseByMetadata(matches: LangfuseMetadataMatch[]): Promise<number> {
    const traceIds = new Set<string>();
    for (const match of matches) {
      for (const id of await this.listTraceIds(match)) traceIds.add(id);
    }
    if (traceIds.size === 0) return 0;
    await this.deleteTraces([...traceIds]);
    return traceIds.size;
  }

  async listTraceIds(match: LangfuseMetadataMatch): Promise<Set<string>> {
    const filter = JSON.stringify([
      { type: 'stringObject', column: 'metadata', key: match.key, operator: '=', value: match.value },
    ]);
    const ids = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${this.baseUrl}/api/public/v2/observations`);
      url.searchParams.set('fields', 'core');
      url.searchParams.set('limit', String(PAGE_LIMIT));
      url.searchParams.set('filter', filter);
      if (cursor) url.searchParams.set('cursor', cursor);
      const body = await this.request<ObservationPage>('GET', url);
      for (const o of body.data ?? []) if (o.traceId) ids.add(o.traceId);
      const next = body.meta?.cursor;
      if (!next) return ids;
      // A repeated cursor would loop forever.
      if (seenCursors.has(next)) throw new Error('langfuse: observation cursor did not advance');
      seenCursors.add(next);
      cursor = next;
    }
    throw new Error(`langfuse: observation pages exceeded ${MAX_PAGES} for metadata.${match.key}`);
  }

  /** Throws on any failed batch so the job retries. */
  async deleteTraces(traceIds: string[]): Promise<void> {
    for (let i = 0; i < traceIds.length; i += DELETE_BATCH) {
      const batch = traceIds.slice(i, i + DELETE_BATCH);
      await this.request('DELETE', new URL(`${this.baseUrl}/api/public/traces`), { traceIds: batch });
    }
  }

  private async request<T>(method: 'GET' | 'DELETE', url: URL, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: this.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      // Truncated so an HTML error page does not flood the log.
      const detail = await res.text().catch(() => '');
      throw new Error(`langfuse ${method} ${url.pathname} → HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * undefined when Langfuse export is not configured. Throws when it is configured but the site root
 * cannot be derived, so erasure never silently skips Langfuse.
 */
export function langfuseAdminFromEnv(env: NodeJS.ProcessEnv = process.env): LangfuseAdminClient | undefined {
  const otlpEndpoint = env.LANGFUSE_OTLP_ENDPOINT;
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!otlpEndpoint || !publicKey || !secretKey) return undefined;
  const baseUrl = env.LANGFUSE_BASE_URL ?? deriveBaseUrl(otlpEndpoint);
  if (!baseUrl) {
    throw new Error(
      'LANGFUSE_OTLP_ENDPOINT is set but the Langfuse site root cannot be derived from it ' +
        '(expected it to end with /api/public/otel); set LANGFUSE_BASE_URL explicitly — ' +
        'without it §43 installation erasure would silently skip Langfuse.',
    );
  }
  return new LangfuseAdminClient({ baseUrl, publicKey, secretKey });
}

function deriveBaseUrl(otlpEndpoint: string): string | undefined {
  const match = otlpEndpoint.replace(/\/$/, '').match(/^(.*)\/api\/public\/otel$/);
  return match?.[1];
}
