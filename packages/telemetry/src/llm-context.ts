import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Business context for LLM spans, carried via AsyncLocalStorage because the span is created deep in
 * the model wrapper. Required, not decorative: installation erasure locates traces by these labels.
 */
export interface LlmTraceContext {
  /** Groups one review's (or conversation turn's) calls in Langfuse. */
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  /** Erasure is per installation (a tenant may have several), so this must be set. */
  installationId?: string;
  /** `namespace/name`. */
  repo?: string;
  changeRequestNumber?: number;
  /** map / dig / verify / refute / synthesis / conversation / security-scan … */
  stage?: string;
  tags?: string[];
}

const storage = new AsyncLocalStorage<LlmTraceContext>();

/** Nested calls merge with the outer context (inner fields win). */
export function withLlmTraceContext<T>(ctx: LlmTraceContext, fn: () => T): T {
  const merged = { ...storage.getStore(), ...ctx };
  return storage.run(merged, fn);
}

export function currentLlmTraceContext(): LlmTraceContext | undefined {
  return storage.getStore();
}

/** Langfuse only makes `langfuse.trace.metadata.*` keys filterable; other attributes are not. */
export function llmTraceAttributes(ctx: LlmTraceContext | undefined): Record<string, string | number | string[]> {
  if (!ctx) return {};
  const attrs: Record<string, string | number | string[]> = {};
  if (ctx.sessionId) attrs['langfuse.session.id'] = ctx.sessionId;
  if (ctx.userId) attrs['langfuse.user.id'] = ctx.userId;
  if (ctx.tags?.length) attrs['langfuse.trace.tags'] = ctx.tags;
  if (ctx.tenantId) attrs['langfuse.trace.metadata.tenant'] = ctx.tenantId;
  if (ctx.installationId) attrs['langfuse.trace.metadata.installation'] = ctx.installationId;
  if (ctx.repo) attrs['langfuse.trace.metadata.repo'] = ctx.repo;
  if (ctx.changeRequestNumber !== undefined) attrs['langfuse.trace.metadata.pr'] = ctx.changeRequestNumber;
  if (ctx.stage) attrs['langfuse.trace.metadata.stage'] = ctx.stage;
  return attrs;
}
