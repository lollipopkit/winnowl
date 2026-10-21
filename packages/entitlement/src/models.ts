import type { Db } from '@reviewbot/db';

/**
 * Model registry: names and a metadata reference only. baseUrl and apiKey stay in env so secrets never reach the DB
 * and a DB row cannot route prompts to an unvetted endpoint.
 */
export interface RegisteredModel {
  /** Reference rows by this; display as `provider/modelId`. */
  id: string;
  /** Structurally compatible with agent-pi `ModelIdentity`; not imported to avoid depending on the LLM runtime. */
  provider: string;
  modelId: string;
  active: boolean;
  sort: number;
  metadataRef?: { source: string; provider: string; modelId: string };
  /** undefined when the catalog reference dangles; runtime then falls back to the built-in catalog. */
  metadata?: ModelMetadataView;
}

/** Same shape as agent-pi `ModelMetadata` (intentionally not imported). */
export interface ModelMetadataView {
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

interface ModelRow {
  id: string;
  provider: string;
  model_id: string;
  metadata_source: string | null;
  metadata_provider: string | null;
  metadata_model_id: string | null;
  active: boolean;
  sort: number;
}

interface CatalogRow {
  source: string;
  provider: string;
  model_id: string;
  name: string;
  context_window: number;
  max_tokens: number;
  reasoning: boolean;
  input: string;
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

const MODEL_COLUMNS = ['id', 'provider', 'model_id', 'metadata_source', 'metadata_provider', 'metadata_model_id', 'active', 'sort'] as const;

const refKey = (source: string, provider: string, modelId: string): string => `${source}\u0000${provider}\u0000${modelId}`;

function rowToModel(row: ModelRow, catalog: Map<string, CatalogRow>): RegisteredModel {
  const ref =
    row.metadata_source && row.metadata_provider && row.metadata_model_id
      ? { source: row.metadata_source, provider: row.metadata_provider, modelId: row.metadata_model_id }
      : undefined;
  const hit = ref ? catalog.get(refKey(ref.source, ref.provider, ref.modelId)) : undefined;
  return {
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    active: row.active,
    sort: row.sort,
    ...(ref ? { metadataRef: ref } : {}),
    ...(hit
      ? {
          metadata: {
            name: hit.name,
            contextWindow: hit.context_window,
            maxTokens: hit.max_tokens,
            reasoning: hit.reasoning,
            input: hit.input.split(',').filter((x): x is 'text' | 'image' => x === 'text' || x === 'image'),
            cost: hit.cost,
          },
        }
      : {}),
  };
}

async function loadCatalog(db: Db, rows: ModelRow[]): Promise<Map<string, CatalogRow>> {
  const refs = rows.filter((r) => r.metadata_source && r.metadata_provider && r.metadata_model_id);
  if (refs.length === 0) return new Map();
  const hits = (await db
    .selectFrom('model_catalog')
    .select(['source', 'provider', 'model_id', 'name', 'context_window', 'max_tokens', 'reasoning', 'input', 'cost'])
    .where('source', 'in', [...new Set(refs.map((r) => r.metadata_source!))])
    .where('model_id', 'in', [...new Set(refs.map((r) => r.metadata_model_id!))])
    .execute()) as CatalogRow[];
  return new Map(hits.map((h) => [refKey(h.source, h.provider, h.model_id), h]));
}

/** Includes inactive models. */
export async function listModels(db: Db): Promise<RegisteredModel[]> {
  const rows = (await db
    .selectFrom('models')
    .select(MODEL_COLUMNS)
    .orderBy('sort')
    .orderBy('model_id')
    .execute()) as ModelRow[];
  const catalog = await loadCatalog(db, rows);
  return rows.map((r) => rowToModel(r, catalog));
}

/** Active models by sort: the candidate set for per-stage selection. Empty = callers fall back to env/tier. */
export async function activeModels(db: Db): Promise<RegisteredModel[]> {
  const rows = (await db
    .selectFrom('models')
    .select(MODEL_COLUMNS)
    .where('active', '=', true)
    .orderBy('sort')
    .orderBy('model_id')
    .execute()) as ModelRow[];
  const catalog = await loadCatalog(db, rows);
  return rows.map((r) => rowToModel(r, catalog));
}

export interface EffectiveModel {
  /** null = empty registry; callers fall back to env/tier. */
  model: RegisteredModel | null;
  allowed: RegisteredModel[];
}

/** Model for stages without a configured list: the first active model by sort. Per-plan differences live in `plan_stage_models`. */
export async function resolveDefaultModel(db: Db): Promise<EffectiveModel> {
  const allowed = await activeModels(db);
  return { model: allowed[0] ?? null, allowed };
}
