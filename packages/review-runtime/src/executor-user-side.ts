import type { ModelSourceConfig } from '@reviewbot/agent-pi';
import type { ReviewExecutorSpec } from './executor-spec.js';

/**
 * Executors on user-side planes (GitHub Actions) call models with the user's own key, so the spec they get
 * carries model identities only: no key, no platform endpoint, no relay token, no Langfuse credentials.
 * Embedding dedup needs a keyed endpoint and falls back to LLM dedup. Throws if a secret would remain.
 */
export function unkeyedExecutorSpec(spec: ReviewExecutorSpec): ReviewExecutorSpec {
  const bare = ({ apiKey: _k, baseUrl: _b, relay: _r, ...rest }: ModelSourceConfig): ModelSourceConfig => rest;
  const out: ReviewExecutorSpec = { ...spec, model: bare(spec.model) };
  if (spec.fallbackModels) out.fallbackModels = spec.fallbackModels.map(bare);
  if (spec.stageModels) out.stageModels = spec.stageModels.map((s) => ({ ...s, models: s.models.map(bare) }));
  if (spec.dedup?.kind === 'embedding') out.dedup = { kind: 'llm' };
  if (spec.plugins) out.plugins = { config: spec.plugins.config };
  if (spec.telemetry) {
    const { langfuseEndpoint: _e, langfusePublicKey: _p, langfuseSecretKey: _s, ...rest } = spec.telemetry;
    out.telemetry = rest;
  }

  const models = [spec.model, ...(spec.fallbackModels ?? []), ...(spec.stageModels ?? []).flatMap((s) => s.models)];
  const secrets = [
    ...models.flatMap((m) => [m.apiKey, m.relay?.token]),
    spec.dedup?.kind === 'embedding' ? spec.dedup.apiKey : undefined,
    ...Object.values(spec.plugins?.credentials ?? {}),
    ...Object.values(spec.plugins?.platformEnv ?? {}),
    spec.telemetry?.langfuseSecretKey,
  ].filter((s): s is string => typeof s === 'string' && s.length >= 8);
  const text = JSON.stringify(out);
  if (secrets.some((s) => text.includes(s))) {
    throw new Error('unkeyedExecutorSpec: a platform secret would still leave the control plane');
  }
  return out;
}

/** Which env the user-side executor reads; documented in the GitHub Action's inputs. */
export interface LocalModelEnv {
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_PROVIDER?: string;
  /** One model for every stage, replacing the platform's choice (and its fallbacks and stage models). */
  LLM_MODEL?: string;
  LLM_TEMPLATE_MODEL?: string;
  EXA_API_KEY?: string;
  CONTEXT7_API_KEY?: string;
}

export class LocalCredentialsError extends Error {
  override readonly name = 'LocalCredentialsError';
}

/**
 * The executor-side half of {@link unkeyedExecutorSpec}: attaches the user's endpoint and key. Without
 * `LLM_MODEL` the platform's model ids are kept, so the user's endpoint must serve them.
 */
export function bindLocalCredentials(spec: ReviewExecutorSpec, env: LocalModelEnv): ReviewExecutorSpec {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) throw new LocalCredentialsError('LLM_API_KEY is not set: the review calls models with your own key');
  const baseUrl = env.LLM_BASE_URL?.trim() || undefined;
  const keyed = (m: ModelSourceConfig): ModelSourceConfig => ({ ...m, apiKey, ...(baseUrl ? { baseUrl } : {}) });

  let out: ReviewExecutorSpec;
  const model = env.LLM_MODEL?.trim();
  if (model) {
    const { fallbackModels: _f, stageModels: _s, ...rest } = spec;
    const template = env.LLM_TEMPLATE_MODEL?.trim();
    out = {
      ...rest,
      model: keyed({
        provider: env.LLM_PROVIDER?.trim() || spec.model.provider,
        modelId: model,
        ...(template ? { templateModelId: template } : {}),
        ...(spec.model.cacheRetention ? { cacheRetention: spec.model.cacheRetention } : {}),
        ...(spec.model.requestTimeoutMs ? { requestTimeoutMs: spec.model.requestTimeoutMs } : {}),
      }),
    };
  } else {
    out = { ...spec, model: keyed(spec.model) };
    if (spec.fallbackModels) out.fallbackModels = spec.fallbackModels.map(keyed);
    if (spec.stageModels) out.stageModels = spec.stageModels.map((s) => ({ ...s, models: s.models.map(keyed) }));
  }
  if (spec.plugins) {
    const platformEnv = Object.fromEntries(
      (['EXA_API_KEY', 'CONTEXT7_API_KEY'] as const).flatMap((k) => (env[k]?.trim() ? [[k, env[k]!.trim()]] : [])),
    );
    out.plugins = { config: spec.plugins.config, platformEnv };
  }
  return out;
}

/** The last stderr line (sandbox) or error body (Actions) an executor reports on failure. */
export interface ExecutorErrorReport {
  error?: string;
  name?: string;
  failureKind?: string;
  failureDetail?: string;
  /** Wall clock expired with zero candidates: the control plane must not retry it. */
  deadlineCut?: boolean;
}

export function executorErrorReport(err: unknown): ExecutorErrorReport {
  const e = err as ExecutorErrorReport & { message?: string };
  return {
    ...(e?.message ? { error: e.message } : {}),
    ...(e?.name ? { name: e.name } : {}),
    ...(e?.failureKind ? { failureKind: e.failureKind } : {}),
    ...(e?.failureDetail ? { failureDetail: e.failureDetail } : {}),
    ...(e?.deadlineCut === true ? { deadlineCut: true } : {}),
  };
}
