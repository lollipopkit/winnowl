import type { Db } from '@reviewbot/db';

/** Syncable model specs (context, output limit, modalities, prices) that registry entries point at. */

export const MODELS_DEV_SOURCE = 'models.dev';

/** Hard-coded, not configurable via env/DB, so a config row cannot point server requests elsewhere (SSRF). */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

export interface CatalogEntry {
  source: string;
  provider: string;
  modelId: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** models.dev `api.json`: { [providerId]: { models: { [modelId]: {...} } } } */
interface ModelsDevModel {
  name?: unknown;
  reasoning?: unknown;
  modalities?: { input?: unknown };
  limit?: { context?: unknown; output?: unknown };
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Returns undefined without input/output prices: a priceless entry would make cost caps read 0. */
export function parseModelsDevEntry(provider: string, modelId: string, m: ModelsDevModel): CatalogEntry | undefined {
  const input = num(m.cost?.input);
  const output = num(m.cost?.output);
  if (input === undefined || output === undefined) return undefined;
  const context = num(m.limit?.context) ?? 0;
  const maxOut = num(m.limit?.output) ?? 0;
  // Zero-context entries are mostly image/embedding models; as chat specs their budget would be 0.
  if (context <= 0 || maxOut <= 0) return undefined;
  const modalities = Array.isArray(m.modalities?.input) ? (m.modalities.input as unknown[]) : ['text'];
  const cacheRead = num(m.cost?.cache_read);
  const cacheWrite = num(m.cost?.cache_write);
  return {
    source: MODELS_DEV_SOURCE,
    provider,
    modelId,
    name: typeof m.name === 'string' && m.name ? m.name : modelId,
    contextWindow: context,
    maxTokens: maxOut,
    reasoning: m.reasoning === true,
    input: modalities.includes('image') ? ['text', 'image'] : ['text'],
    cost: {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
  };
}

/** Malformed entries are skipped; some upstream entries routinely lack fields. */
export function parseModelsDev(json: unknown): CatalogEntry[] {
  if (typeof json !== 'object' || json === null) return [];
  const out: CatalogEntry[] = [];
  for (const [providerId, p] of Object.entries(json as Record<string, unknown>)) {
    const models = (p as { models?: unknown })?.models;
    if (typeof models !== 'object' || models === null) continue;
    for (const [modelId, m] of Object.entries(models as Record<string, ModelsDevModel>)) {
      const entry = parseModelsDevEntry(providerId, modelId, m);
      if (entry) out.push(entry);
    }
  }
  return out;
}

export interface CatalogSyncResult {
  source: string;
  fetched: number;
  total: number;
  /** Entries removed because upstream delisted them. */
  removed: number;
  /** Reported separately: price changes alter cost-cap behaviour for registered models. */
  repriced: { provider: string; modelId: string; from: { input: number; output: number }; to: { input: number; output: number } }[];
}

/**
 * Replaces the whole source rather than upserting, so delisted entries disappear instead of billing on stale prices;
 * dangling references are visible in the UI and fall back to the built-in catalog at runtime.
 */
export async function syncModelCatalog(
  db: Db,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogSyncResult> {
  const res = await fetchImpl(MODELS_DEV_URL, {
    // Following redirects would defeat the hard-coded URL.
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`模型目录同步失败:${MODELS_DEV_URL} 返回 ${res.status}`);
  const entries = parseModelsDev(await res.json());
  if (entries.length === 0) {
    // An empty result would wipe the catalog; treat it as a failed sync.
    throw new Error(`模型目录同步失败:${MODELS_DEV_URL} 未解析出任何条目`);
  }

  const before = await db
    .selectFrom('model_catalog')
    .select(['provider', 'model_id', 'cost'])
    .where('source', '=', MODELS_DEV_SOURCE)
    .execute();
  const priceOf = new Map(before.map((r) => [`${r.provider}/${r.model_id}`, r.cost]));
  const now = new Date();

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('model_catalog').where('source', '=', MODELS_DEV_SOURCE).execute();
    // Batched to stay under the bind-parameter limit.
    for (let i = 0; i < entries.length; i += 500) {
      await trx
        .insertInto('model_catalog')
        .values(
          entries.slice(i, i + 500).map((e) => ({
            source: e.source,
            provider: e.provider,
            model_id: e.modelId,
            name: e.name,
            context_window: e.contextWindow,
            max_tokens: e.maxTokens,
            reasoning: e.reasoning,
            input: e.input.join(','),
            // jsonb must be serialized explicitly for node-pg.
            cost: JSON.stringify(e.cost),
            synced_at: now,
          })),
        )
        .execute();
    }
  });

  const seen = new Set(entries.map((e) => `${e.provider}/${e.modelId}`));
  const repriced: CatalogSyncResult['repriced'] = [];
  for (const e of entries) {
    const old = priceOf.get(`${e.provider}/${e.modelId}`);
    if (!old) continue;
    if (old.input !== e.cost.input || old.output !== e.cost.output) {
      repriced.push({
        provider: e.provider,
        modelId: e.modelId,
        from: { input: old.input, output: old.output },
        to: { input: e.cost.input, output: e.cost.output },
      });
    }
  }
  return {
    source: MODELS_DEV_SOURCE,
    fetched: entries.length,
    total: entries.length,
    removed: before.filter((r) => !seen.has(`${r.provider}/${r.model_id}`)).length,
    repriced,
  };
}
