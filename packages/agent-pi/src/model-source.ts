import { getModel, getModels, registerBuiltInApiProviders, streamSimple } from '@earendil-works/pi-ai/compat';
import type { Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { currentLlmTraceContext, getTracer, llmTraceAttributes, recordLlmCall, SpanStatusCode } from '@reviewbot/telemetry';
import { classifyStreamFailure } from './failure.js';
import { withCooldownWait } from './cooldown-wait.js';

/** Per-request output token cap (see `createModelSource`). */
export const MAX_OUTPUT_TOKENS_PER_REQUEST = 128_000;

export interface ResolvedModelSource {
  model: Model<string>;
  streamFn: StreamFn;
  /** The resolved config; serialized into the executor spec so the sandbox can rebuild streamFn. */
  config?: ModelSourceConfig;
}

/** Model specs used locally only (budgets, cost, image support, thinking params); requests send just `modelId`. */
export interface ModelMetadata {
  /** Display name; defaults to modelId. */
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** Models without `image` are never given PR images. */
  input: ('text' | 'image')[];
  /** USD per million tokens, same unit as the pi catalog. */
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export interface ModelSourceConfig {
  /** pi provider id (e.g. openai / deepseek / anthropic). */
  provider: string;
  modelId: string;
  /** Custom OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** Injected via stream options; never logged. */
  apiKey?: string;
  /** Explicit specs from the registry; take precedence over the built-in catalog entry of the same name. */
  metadata?: ModelMetadata;
  /** Catalog model (same api) used as template when modelId is not in the catalog; for the env and BYOK paths. */
  templateModelId?: string;
  /** Providers map it (Anthropic cache_control.ttl, OpenAI prompt_cache_retention); omit or `none` disables. */
  cacheRetention?: 'none' | 'short' | 'long';
  /**
   * Wall-clock cap per LLM call (ms); defaults to env `LLM_REQUEST_TIMEOUT_MS`, then 10 min.
   * Without it a stalled gateway connection hangs the job forever while heartbeats keep renewing its lease.
   */
  requestTimeoutMs?: number;
  /**
   * Send requests through the platform's model relay instead of to the endpoint directly: `url`
   * replaces the endpoint for the request and `token` the key. The relay holds the real key and
   * forwards to `baseUrl` (or the catalog endpoint). How sandboxes call models without holding a key.
   * `baseUrl` keeps describing the real endpoint (and with it the endpoint's compat).
   */
  relay?: { url: string; token: string };
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/** Explicit > env > default; a non-positive value disables the timeout. */
export function resolveRequestTimeoutMs(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (explicit !== undefined) return explicit;
  const fromEnv = Number(env.LLM_REQUEST_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv !== 0 ? fromEnv : DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Timeout watchdog merged with the caller's signal. Uses its own controller instead of `AbortSignal.timeout`
 * so the abort reason text is fixed and `classifyStreamFailure` classifies it as a retryable timeout.
 */
export function createRequestAbort(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (!(timeoutMs > 0)) return { signal: callerSignal, dispose: () => undefined };
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`LLM 请求超时:${timeoutMs}ms 内未完成(aborted by timeout watchdog)`));
  }, timeoutMs);
  // Do not keep the process alive.
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/** Subset of pi-ai's AssistantMessage returned by `AssistantMessageEventStream.result()`. */
interface StreamResult {
  stopReason?: string;
  errorMessage?: string;
  responseModel?: string;
  content?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    totalTokens?: number;
    /** Cost computed by pi from the model price table. */
    cost?: { total?: number; input?: number; output?: number; cacheRead?: number };
  };
}

/**
 * Byte limit for prompt/response bodies on spans; 0 (off) unless `LLM_TRACE_BODIES=1`.
 * Bodies contain customer source code: only enable with a self-hosted backend that installation erasure can purge.
 */
export function bodyCaptureLimit(env: NodeJS.ProcessEnv = process.env): number {
  if (env.LLM_TRACE_BODIES !== '1') return 0;
  const n = Number(env.LLM_TRACE_BODY_LIMIT_BYTES);
  // Prompts can exceed 100 KB, beyond observation field limits.
  return Number.isFinite(n) && n > 0 ? n : 32_768;
}

/** Serialize and truncate, marking the cut so partial JSON is not mistaken for the real input. */
export function serializeBody(value: unknown, limit: number): string | undefined {
  if (limit <= 0 || value === undefined) return undefined;
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return undefined; // e.g. circular refs: telemetry must never break the call
  }
  if (!text) return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`;
}

/** No-op when telemetry is disabled (as in the sandbox). */
const llmTracer = getTracer('agent-pi');

/**
 * OTel `gen_ai.*` span plus Prometheus metric for one LLM call, settled at one point so they always agree.
 * Every LLM call goes through createModelSource's streamFn. Bodies are recorded only per `bodyCaptureLimit`.
 */
export function observeLlmCall(
  provider: string,
  modelId: string,
  requestContext?: unknown,
): { settle: (r?: StreamResult) => void } {
  const limit = bodyCaptureLimit();
  const span = llmTracer.startSpan(`chat ${modelId}`, {
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': modelId,
      // Tenant/repo/PR/stage: needed for filtering and for erasure.
      ...llmTraceAttributes(currentLlmTraceContext()),
    },
  });
  const prompt = serializeBody(requestContext, limit);
  if (prompt !== undefined) span.setAttribute('gen_ai.prompt', prompt);
  const startedMs = Date.now();
  let settled = false;
  return {
    settle: (r?: StreamResult) => {
      if (settled) return;
      settled = true;
      const durationSec = (Date.now() - startedMs) / 1000;
      // pi does not throw on failure; it sets stopReason='error'|'aborted' and errorMessage.
      const failed = r?.stopReason === 'error' || r?.stopReason === 'aborted' || r?.errorMessage !== undefined;
      const kind = failed ? classifyStreamFailure(r?.errorMessage) : 'none';
      if (r?.stopReason) span.setAttribute('gen_ai.response.finish_reasons', [r.stopReason]);
      if (r?.responseModel) span.setAttribute('gen_ai.response.model', r.responseModel);
      if (r?.usage?.input !== undefined) span.setAttribute('gen_ai.usage.input_tokens', r.usage.input);
      if (r?.usage?.output !== undefined) span.setAttribute('gen_ai.usage.output_tokens', r.usage.output);
      if (r?.usage?.cacheRead !== undefined) span.setAttribute('gen_ai.usage.cache_read_tokens', r.usage.cacheRead);
      // Langfuse cannot price gateway model names itself.
      if (r?.usage?.cost?.total !== undefined) span.setAttribute('gen_ai.usage.cost', r.usage.cost.total);
      const completion = serializeBody(r?.content, limit);
      if (completion !== undefined) span.setAttribute('gen_ai.completion', completion);
      if (failed) {
        span.setAttribute('error.type', kind);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (r?.errorMessage ?? '').slice(0, 500) });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
      recordLlmCall(modelId, failed ? 'error' : 'ok', kind, durationSec);
    },
  };
}

let registered = false;
function ensureRegistered(): void {
  if (!registered) {
    registerBuiltInApiProviders();
    registered = true;
  }
}

const getModelDynamic = getModel as unknown as (provider: string, modelId: string) => Model<string> | undefined;


const getModelsDynamic = getModels as unknown as (provider: string) => Model<string>[] | undefined;

/**
 * The catalog model that carries the API protocol (and default endpoint) for a config.
 * Protocol is per provider; per-model specs come from `metadata` when given.
 */
function carrierModel(config: ModelSourceConfig): Model<string> | undefined {
  ensureRegistered();
  return (
    getModelDynamic(config.provider, config.modelId) ??
    (config.templateModelId ? getModelDynamic(config.provider, config.templateModelId) : undefined) ??
    // With explicit metadata, any model of the provider carries the protocol.
    (config.metadata ? getModelsDynamic(config.provider)?.[0] : undefined)
  );
}

/** Whether pi's built-in catalog describes this model (protocol, limits, prices) without help. */
export function isCatalogModel(provider: string, modelId: string): boolean {
  ensureRegistered();
  return getModelDynamic(provider, modelId) !== undefined;
}

/** The endpoint requests for this config really go to (the relay forwards there). */
export function upstreamBaseUrl(config: ModelSourceConfig): string {
  const base = config.baseUrl ?? carrierModel(config)?.baseUrl;
  if (!base) throw new Error(`no endpoint known for ${config.provider}/${config.modelId}`);
  return base;
}

export function createModelSource(config: ModelSourceConfig): ResolvedModelSource {
  const carrier = carrierModel(config);
  if (!carrier) {
    throw new Error(
      `未知模型 ${config.provider}/${config.modelId};请在注册表里给它挑一条模型元数据,或设 templateModelId(同 api 的目录模型,如 gpt-4o)`,
    );
  }

  const md = config.metadata;
  const model: Model<string> = { ...carrier, id: config.modelId };
  if (md) {
    model.name = md.name ?? config.modelId;
    model.contextWindow = md.contextWindow;
    model.maxTokens = md.maxTokens;
    model.reasoning = md.reasoning;
    model.input = [...md.input];
    // Missing cache prices fall back to the input price, not 0, so the cost gate never underestimates.
    // Replacing the whole object also drops the carrier's `tiers`, which belong to another model.
    model.cost = {
      input: md.cost.input,
      output: md.cost.output,
      cacheRead: md.cost.cacheRead ?? md.cost.input,
      cacheWrite: md.cost.cacheWrite ?? md.cost.input,
    };
    // The carrier's thinking level names belong to another model; endpoints reject unknown ones.
    delete (model as { thinkingLevelMap?: unknown }).thinkingLevelMap;
  }
  // pi sends `model.maxTokens` as `max_tokens`; specs from other resellers can exceed the gateway's limit (400).
  if (model.maxTokens > MAX_OUTPUT_TOKENS_PER_REQUEST) model.maxTokens = MAX_OUTPUT_TOKENS_PER_REQUEST;
  if (config.baseUrl !== undefined) {
    model.baseUrl = config.baseUrl;
    // Catalog compat describes the official endpoint; gateways reject `prompt_cache_options` with a 400.
    // With it disabled pi falls back to the standard `prompt_cache_retention`.
    const compat = model.compat as Record<string, unknown> | undefined;
    if (compat) (model as { compat?: unknown }).compat = { ...compat, supportsExplicitPromptCacheMode: false };
  }
  // The relay forwards to the endpoint above unchanged; only where requests go and with what key differs.
  if (config.relay) model.baseUrl = config.relay.url;

  const apiKey = config.relay?.token ?? config.apiKey;
  const cacheRetention = config.cacheRetention && config.cacheRetention !== 'none' ? config.cacheRetention : undefined;
  const timeoutMs = resolveRequestTimeoutMs(config.requestTimeoutMs);
  // Outermost so each retry is a separate request with its own watchdog and telemetry.
  const streamFn = withCooldownWait(((m: unknown, context: unknown, options?: unknown) => {
    const opts = (options as Record<string, unknown>) ?? {};
    const { signal, dispose } = createRequestAbort(timeoutMs, opts.signal as AbortSignal | undefined);
    const call = observeLlmCall(config.provider, config.modelId, context);
    const out = (streamSimple as unknown as (mm: Model<string>, ctx: unknown, opts?: unknown) => unknown)(
      m as Model<string>,
      context,
      {
        ...opts,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(cacheRetention ? { cacheRetention } : {}),
        ...(signal ? { signal } : {}),
      },
    );
    // Do not wrap the stream: AssistantMessageEventStream is a class whose result() a generator wrapper would lose.
    void Promise.resolve(out as PromiseLike<{ result?: () => Promise<StreamResult> }>)
      .then((s) => s?.result?.())
      .then(
        (r) => call.settle(r),
        (err) => call.settle({ stopReason: 'error', errorMessage: (err as Error)?.message }),
      )
      .finally(dispose);
    return out;
  }) as unknown as StreamFn);

  return { model, streamFn, config };
}

export type ModelTier = 'quality' | 'balanced' | 'cheap';

const TIER_SUFFIX: Record<ModelTier, string> = { quality: 'QUALITY', balanced: 'BALANCED', cheap: 'CHEAP' };

/** Thrown when an endpoint is not on the ZDR allowlist. */
export class ModelEndpointNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelEndpointNotAllowedError';
  }
}

function parseList(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Fail-closed allowlist so source code only reaches approved zero-retention endpoints. The provider must be in
 * `LLM_ALLOWED_PROVIDERS` if set; a custom base URL must prefix-match `LLM_ALLOWED_BASE_URLS`, which must be set.
 */
export function assertModelEndpointAllowed(input: { provider: string; baseUrl?: string }, env: NodeJS.ProcessEnv = process.env): void {
  const allowedProviders = parseList(env.LLM_ALLOWED_PROVIDERS);
  if (allowedProviders.length > 0 && !allowedProviders.includes(input.provider)) {
    throw new ModelEndpointNotAllowedError(`LLM provider "${input.provider}" 不在 LLM_ALLOWED_PROVIDERS 白名单`);
  }
  if (input.baseUrl) {
    const allowed = parseList(env.LLM_ALLOWED_BASE_URLS);
    if (allowed.length === 0) {
      throw new ModelEndpointNotAllowedError('设置了自定义 LLM_BASE_URL 但未配 LLM_ALLOWED_BASE_URLS(ZDR 白名单);拒绝把 prompt 发往未审端点');
    }
    if (!allowed.some((u) => input.baseUrl!.startsWith(u))) {
      throw new ModelEndpointNotAllowedError('LLM_BASE_URL 未在 LLM_ALLOWED_BASE_URLS(ZDR 白名单)');
    }
  }
}

/** Model identity from the DB registry; baseUrl/apiKey still come only from env and the allowlist still applies. */
export interface ModelIdentity {
  provider: string;
  modelId: string;
  templateModelId?: string;
  /** Carried with the identity so the sandbox side receives it. */
  metadata?: ModelMetadata;
}

/** A tier (resolved from env) or a concrete identity from the DB registry. */
export type ModelSelector = ModelTier | ModelIdentity;

function isIdentity(v: ModelSelector | undefined): v is ModelIdentity {
  return typeof v === 'object' && v !== null;
}

export function resolveModelSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  selector?: ModelSelector,
): ResolvedModelSource | null {
  const identity = isIdentity(selector) ? selector : undefined;
  const tier = isIdentity(selector) ? undefined : selector;
  const provider = identity?.provider ?? env.LLM_PROVIDER;
  const suffix = tier ? TIER_SUFFIX[tier] : undefined;
  const modelId = identity?.modelId ?? (suffix ? env[`LLM_MODEL_${suffix}`] : undefined) ?? env.LLM_MODEL;
  if (!provider || !modelId) return null;
  assertModelEndpointAllowed({ provider, ...(env.LLM_BASE_URL ? { baseUrl: env.LLM_BASE_URL } : {}) }, env);
  const templateModelId = identity
    ? identity.templateModelId
    : (suffix ? env[`LLM_TEMPLATE_MODEL_${suffix}`] : undefined) ?? env.LLM_TEMPLATE_MODEL;
  const cacheRetention = ((): 'none' | 'short' | 'long' => {
    const v = (env.LLM_CACHE_RETENTION ?? 'long').trim().toLowerCase();
    return v === 'none' || v === 'short' || v === 'long' ? v : 'long';
  })();
  return createModelSource({
    provider,
    modelId,
    cacheRetention,
    // Resolved here because the config is serialized into the sandbox executor spec, which has no env.
    requestTimeoutMs: resolveRequestTimeoutMs(undefined, env),
    ...(env.LLM_BASE_URL ? { baseUrl: env.LLM_BASE_URL } : {}),
    ...(env.LLM_API_KEY ? { apiKey: env.LLM_API_KEY } : {}),
    ...(templateModelId ? { templateModelId } : {}),
    ...(identity?.metadata ? { metadata: identity.metadata } : {}),
  });
}
