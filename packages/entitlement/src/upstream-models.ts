/**
 * Model ids the gateway serves (`GET /v1/models`); specs and prices come from `model_catalog` instead.
 * The endpoint comes only from env, never from the caller: the request carries the platform API key (SSRF).
 */

const TIMEOUT_MS = 10_000;

export interface UpstreamModel {
  id: string;
  /** Gateway `owned_by`, if any. */
  ownedBy?: string;
}

export interface UpstreamModelList {
  /** Sorted by id; gateway order is unstable. */
  items: UpstreamModel[];
  /** Provider to register these under (the configured adapter name). */
  defaultProvider: string;
}

interface RawModel {
  id?: unknown;
  owned_by?: unknown;
}

/** Accepts `{data:[...]}`, `{models:[...]}` or a bare array; entries without an id are skipped. */
export function parseUpstreamModels(body: unknown): UpstreamModel[] {
  const raw = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: unknown[] }).data)
      : Array.isArray((body as { models?: unknown })?.models)
        ? ((body as { models: unknown[] }).models)
        : [];
  const out: UpstreamModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const m = entry as RawModel;
    const id = typeof m?.id === 'string' ? m.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = typeof m?.owned_by === 'string' && m.owned_by.trim() ? m.owned_by.trim() : undefined;
    out.push({ id, ...(ownedBy ? { ownedBy } : {}) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export class UpstreamModelsUnavailableError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UpstreamModelsUnavailableError';
    if (status !== undefined) this.status = status;
  }
}

/** Not cached: the operator asks precisely to see what is available now. */
export async function fetchUpstreamModels(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamModelList> {
  const baseUrl = env.LLM_BASE_URL?.replace(/\/+$/, '');
  const apiKey = env.LLM_API_KEY;
  if (!baseUrl) throw new UpstreamModelsUnavailableError('未配 LLM_BASE_URL,无从拉上游模型清单');
  const res = await fetchImpl(`${baseUrl}/models`, {
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new UpstreamModelsUnavailableError(`拉上游模型清单失败:${(err as Error)?.message ?? 'unknown'}`);
  });
  if (!res.ok) {
    throw new UpstreamModelsUnavailableError(`上游 /models 返回 ${res.status}`, res.status);
  }
  const items = parseUpstreamModels(await res.json().catch(() => null));
  return { items, defaultProvider: env.LLM_PROVIDER ?? 'openai' };
}
