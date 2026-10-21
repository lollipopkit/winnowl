import { isCatalogModel, type ModelMetadata } from '@reviewbot/agent-pi';
import type { Database, Db, ExpressionBuilder } from '@reviewbot/db';
import { decryptEnvelope, type EncryptedEnvelope, type MasterKeyProvider } from '@reviewbot/kms';
import { deleteServiceCredential, storeServiceCredential } from './credentials.js';

/**
 * Bring-your-own LLM key. Endpoints are hard-coded per provider and no custom URL is accepted
 * (prevents SSRF and exfiltrating code to attacker endpoints). The whole config is KMS envelope
 * encrypted in `service_credentials` (user > repo > org) and the key is never echoed back.
 */

/** Keyed by pi provider id. This table is the endpoint allowlist; config cannot override it. */
export const BYOK_PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1' },
  anthropic: { baseUrl: 'https://api.anthropic.com' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1' },
  deepseek: { baseUrl: 'https://api.deepseek.com' },
} as const;

export type ByokProvider = keyof typeof BYOK_PROVIDERS;

export function isByokProvider(v: string): v is ByokProvider {
  return Object.prototype.hasOwnProperty.call(BYOK_PROVIDERS, v);
}

export const LLM_SERVICE = 'llm' as const;

export interface ByokConfig {
  provider: ByokProvider;
  /** Balanced tier; also the fallback for unset tiers. */
  model: string;
  apiKey: string;
  modelQuality?: string;
  modelCheap?: string;
  /** pi catalog model used as a template when the model is in neither pi's nor models.dev's catalog. */
  templateModel?: string;
}

/** The configured model fields, in the order they are checked and shown. */
export const BYOK_MODEL_FIELDS = ['model', 'modelQuality', 'modelCheap'] as const;

/**
 * A configuration the platform refuses. `code` and `field` are for the console (it localises them);
 * `message` is the English detail for logs and API clients.
 */
export class ByokConfigError extends Error {
  constructor(
    readonly code:
      | 'unknown_field'
      | 'missing_field'
      | 'invalid_field'
      | 'unknown_provider'
      | 'model_unavailable'
      | 'model_spec_unknown',
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ByokConfigError';
  }
}

/** The provider did not accept the key, or could not be asked. Never carries the key. */
export class ByokCheckError extends Error {
  constructor(
    readonly code: 'key_rejected' | 'provider_unreachable' | 'provider_error',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ByokCheckError';
  }
}

const MAX_FIELD = 200;
const ALLOWED_FIELDS = new Set(['provider', 'model', 'apiKey', 'modelQuality', 'modelCheap', 'templateModel']);

/** A submitted configuration whose key may be omitted (the stored key is kept, see `PUT /v1/byok`). */
export type ByokUpdate = Omit<ByokConfig, 'apiKey'> & { apiKey?: string };

/** Rejects unknown providers, missing fields and any extra field (notably URLs). */
export function parseByokUpdate(input: unknown, opts: { keyOptional?: boolean } = {}): ByokUpdate {
  if (typeof input !== 'object' || input === null) throw new ByokConfigError('invalid_field', '', 'BYOK configuration must be an object');
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!ALLOWED_FIELDS.has(k)) {
      throw new ByokConfigError('unknown_field', k, `BYOK configuration does not accept "${k}" (endpoints are fixed by the platform)`);
    }
  }
  const str = (k: string, required: boolean): string | undefined => {
    const v = o[k];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      if (required) throw new ByokConfigError('missing_field', k, `BYOK configuration is missing ${k}`);
      return undefined;
    }
    if (typeof v !== 'string' || v.length > MAX_FIELD) throw new ByokConfigError('invalid_field', k, `BYOK ${k} is not a string of at most ${MAX_FIELD} characters`);
    return v.trim();
  };
  const provider = str('provider', true)!;
  if (!isByokProvider(provider)) {
    throw new ByokConfigError('unknown_provider', 'provider', `BYOK provider "${provider}" is not supported (${Object.keys(BYOK_PROVIDERS).join(', ')})`);
  }
  const model = str('model', true)!;
  const apiKey = str('apiKey', !opts.keyOptional);
  const modelQuality = str('modelQuality', false);
  const modelCheap = str('modelCheap', false);
  const templateModel = str('templateModel', false);
  return {
    provider,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(modelQuality ? { modelQuality } : {}),
    ...(modelCheap ? { modelCheap } : {}),
    ...(templateModel ? { templateModel } : {}),
  };
}

export function parseByokConfig(input: unknown): ByokConfig {
  return parseByokUpdate(input) as ByokConfig;
}

type ByokScope = { tenantId: string; repositoryId?: string; userId?: string };

export async function storeByokConfig(db: Db, kek: MasterKeyProvider, scope: ByokScope, config: ByokConfig): Promise<void> {
  await storeServiceCredential(db, kek, {
    tenantId: scope.tenantId,
    ...(scope.repositoryId ? { repositoryId: scope.repositoryId } : {}),
    ...(scope.userId ? { userId: scope.userId } : {}),
    service: LLM_SERVICE,
    apiKey: JSON.stringify(config),
  });
  // A new configuration has no history: the old fallback reason described the old one.
  await db.updateTable('service_credentials').set({ last_used_at: null, last_error: null, last_error_at: null }).where(inScope(scope)).execute();
}

export async function deleteByokConfig(db: Db, scope: ByokScope): Promise<void> {
  await deleteServiceCredential(db, {
    tenantId: scope.tenantId,
    ...(scope.repositoryId ? { repositoryId: scope.repositoryId } : {}),
    ...(scope.userId ? { userId: scope.userId } : {}),
    service: LLM_SERVICE,
  });
}

/** Exactly one scope's BYOK row (for select and update alike). */
function inScope(scope: ByokScope) {
  return (eb: ExpressionBuilder<Database, 'service_credentials'>) =>
    eb.and([
      eb('tenant_id', '=', scope.tenantId),
      eb('service', '=', LLM_SERVICE),
      ...(scope.userId
        ? [eb('user_id', '=', scope.userId)]
        : [eb('user_id', 'is', null), scope.repositoryId ? eb('repository_id', '=', scope.repositoryId) : eb('repository_id', 'is', null)]),
    ]);
}

async function decryptConfig(envelope: unknown, kek: MasterKeyProvider): Promise<ByokConfig> {
  const plain = (await decryptEnvelope(envelope as EncryptedEnvelope, kek)).toString('utf8');
  // Re-validate after decrypt in case a stored row carries disallowed fields.
  return parseByokConfig(JSON.parse(plain));
}

/** Why a review that should have used a BYOK configuration ran on the platform key. */
export type ByokFallbackReason = 'unreadable' | 'provider_disabled' | 'model_unknown';

export type ResolvedByok = { id: string; config: ByokConfig } | { id: string; error: 'unreadable' };

/**
 * user > repo > org; the user level applies only to user-initiated runs (with a userId).
 * Decrypt/parse failures return `error`; the key never reaches logs.
 */
export async function resolveByok(
  db: Db,
  kek: MasterKeyProvider,
  scope: { tenantId: string; repositoryId: string; userId?: string },
): Promise<ResolvedByok | null> {
  const rows = await db
    .selectFrom('service_credentials')
    .select(['id', 'repository_id', 'user_id', 'envelope'])
    .where('tenant_id', '=', scope.tenantId)
    .where('service', '=', LLM_SERVICE)
    .where((eb) =>
      eb.or([
        // A check constraint keeps repository_id null on user rows.
        ...(scope.userId ? [eb('user_id', '=', scope.userId)] : []),
        eb.and([eb('user_id', 'is', null), eb.or([eb('repository_id', 'is', null), eb('repository_id', '=', scope.repositoryId)])]),
      ]),
    )
    .execute();
  const pick =
    (scope.userId ? rows.find((r) => r.user_id === scope.userId) : undefined) ??
    rows.find((r) => r.repository_id !== null && r.user_id === null) ??
    rows.find((r) => r.repository_id === null && r.user_id === null);
  if (!pick) return null;
  try {
    return { id: pick.id, config: await decryptConfig(pick.envelope, kek) };
  } catch {
    return { id: pick.id, error: 'unreadable' };
  }
}

/** Records how a review used the configuration (best effort: status display only). */
export async function recordByokOutcome(db: Db, id: string, fallback?: ByokFallbackReason): Promise<void> {
  const now = new Date();
  await db
    .updateTable('service_credentials')
    .set(fallback ? { last_error: fallback, last_error_at: now } : { last_used_at: now })
    .where('id', '=', id)
    .execute();
}

export interface ByokMeta {
  provider: ByokProvider;
  model: string;
  modelQuality?: string;
  modelCheap?: string;
  templateModel?: string;
  lastUsedAt?: string;
  /** Set when the last review that should have used this configuration fell back after its last use. */
  lastError?: ByokFallbackReason;
  lastErrorAt?: string;
}

/** Exact scope match; null when absent, throws when it cannot be decrypted. */
export async function readByokConfig(db: Db, kek: MasterKeyProvider, scope: ByokScope): Promise<ByokConfig | null> {
  const row = await db.selectFrom('service_credentials').select('envelope').where(inScope(scope)).executeTakeFirst();
  return row ? decryptConfig(row.envelope, kek) : null;
}

/** Display metadata and usage status; never includes the apiKey. */
export async function readByokMeta(db: Db, kek: MasterKeyProvider, scope: ByokScope): Promise<ByokMeta | null> {
  const row = await db
    .selectFrom('service_credentials')
    .select(['envelope', 'last_used_at', 'last_error', 'last_error_at'])
    .where(inScope(scope))
    .executeTakeFirst();
  if (!row) return null;
  let cfg: ByokConfig;
  try {
    cfg = await decryptConfig(row.envelope, kek);
  } catch {
    return null;
  }
  const { apiKey: _apiKey, ...meta } = cfg;
  const errorIsCurrent = row.last_error_at && (!row.last_used_at || row.last_error_at > row.last_used_at);
  return {
    ...meta,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at.toISOString() } : {}),
    ...(errorIsCurrent && row.last_error ? { lastError: row.last_error as ByokFallbackReason, lastErrorAt: row.last_error_at!.toISOString() } : {}),
  };
}

/** Repositories of the tenant that have their own BYOK configuration. */
export async function listByokRepositories(db: Db, tenantId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('service_credentials')
    .select('repository_id')
    .where('tenant_id', '=', tenantId)
    .where('service', '=', LLM_SERVICE)
    .where('repository_id', 'is not', null)
    .execute();
  return rows.map((r) => r.repository_id!);
}

/**
 * How the runtime will describe a model: pi's catalog knows it, or the configured template does, or
 * the models.dev catalog (`model_catalog`, synced by the platform) has its limits and prices.
 * undefined: none does, and the model cannot be run.
 */
export async function byokModelSpec(
  db: Db,
  provider: ByokProvider,
  modelId: string,
  templateModel?: string,
): Promise<{ metadata?: ModelMetadata } | undefined> {
  if (isCatalogModel(provider, modelId)) return {};
  if (templateModel && isCatalogModel(provider, templateModel)) return {};
  const row = await db
    .selectFrom('model_catalog')
    .select(['name', 'context_window', 'max_tokens', 'reasoning', 'input', 'cost'])
    .where('source', '=', 'models.dev')
    .where('provider', '=', provider)
    .where('model_id', '=', modelId)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    metadata: {
      name: row.name,
      contextWindow: row.context_window,
      maxTokens: row.max_tokens,
      reasoning: row.reasoning,
      input: row.input.split(',').filter((x): x is 'text' | 'image' => x === 'text' || x === 'image'),
      cost: row.cost as ModelMetadata['cost'],
    },
  };
}

/** Of `ids`, the models `byokModelSpec` can describe without a template (one catalog query). */
export async function knownByokModelSpecs(db: Db, provider: ByokProvider, ids: readonly string[]): Promise<Set<string>> {
  const known = new Set(ids.filter((id) => isCatalogModel(provider, id)));
  const rest = ids.filter((id) => !known.has(id));
  if (rest.length > 0) {
    const rows = await db
      .selectFrom('model_catalog')
      .select('model_id')
      .where('source', '=', 'models.dev')
      .where('provider', '=', provider)
      .where('model_id', 'in', rest)
      .execute();
    for (const r of rows) known.add(r.model_id);
  }
  return known;
}

const CHECK_TIMEOUT_MS = 10_000;

/**
 * The models the key can use, asked from the provider itself (which also proves the key works).
 * OpenRouter lists models without a key, so the key is checked on its own endpoint first.
 */
export async function listByokModels(provider: ByokProvider, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const base = BYOK_PROVIDERS[provider].baseUrl;
  const headers: Record<string, string> =
    provider === 'anthropic' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` };
  const get = async (url: string): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    } catch (err) {
      throw new ByokCheckError('provider_unreachable', `${provider} could not be reached: ${(err as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new ByokCheckError('key_rejected', `${provider} rejected the key (${res.status})`, res.status);
    if (!res.ok) throw new ByokCheckError('provider_error', `${provider} answered ${res.status}`, res.status);
    return res.json().catch(() => null);
  };
  if (provider === 'openrouter') await get(`${base}/key`);
  const body = await get(provider === 'anthropic' ? `${base}/v1/models?limit=1000` : `${base}/models`);
  const data = (body as { data?: unknown })?.data;
  const ids = (Array.isArray(data) ? data : [])
    .map((m) => (typeof (m as { id?: unknown })?.id === 'string' ? (m as { id: string }).id : ''))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

/**
 * Checks a configuration before it is stored: the key works, every configured model is one the key
 * can use, and the runtime can describe each of them. Throws ByokCheckError / ByokConfigError.
 */
export async function verifyByokConfig(db: Db, config: ByokConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (config.templateModel && !isCatalogModel(config.provider, config.templateModel)) {
    throw new ByokConfigError('model_spec_unknown', 'templateModel', `${config.templateModel} is not a model the platform knows for ${config.provider}`);
  }
  const available = new Set(await listByokModels(config.provider, config.apiKey, fetchImpl));
  for (const field of BYOK_MODEL_FIELDS) {
    const id = config[field];
    if (!id) continue;
    // An empty list means the provider did not say; the key itself was accepted.
    if (available.size > 0 && !available.has(id)) {
      throw new ByokConfigError('model_unavailable', field, `${config.provider} does not offer ${id} to this key`);
    }
    if (!(await byokModelSpec(db, config.provider, id, config.templateModel))) {
      throw new ByokConfigError('model_spec_unknown', field, `no specification (context window, prices) is known for ${config.provider}/${id}; choose a template model`);
    }
  }
}
