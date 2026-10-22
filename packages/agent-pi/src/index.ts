/**
 * Pi agent runtime wrapper for single invocations. Never spawns the pi CLI or exposes pi-coding-agent's default
 * tools; must not depend on publisher.
 */

export { runAgentInvocation, buildSecurityPreamble } from './runner.js';
export { detectInjectionAttempt, type InjectionSignal } from './injection-guard.js';
export { compactMessages, DEFAULT_COMPACTION_POLICY, type CompactionPolicy } from './compaction.js';
export { classifyStreamFailure, isRetryableStreamFailure, shouldTryAnotherModel, type StreamFailureKind } from './failure.js';
export { pruneFinalizationCalls } from './transcript.js';
export type { RunInvocationInput, FinalizationDef, CollectorDef, AgentImage } from './runner.js';

export { buildSubagentTool } from './subagent.js';
export type { SubagentToolOptions } from './subagent.js';

export { resolveModel } from './models.js';
export { createModelSource, isCatalogModel, upstreamBaseUrl, resolveRequestTimeoutMs, createRequestAbort, DEFAULT_REQUEST_TIMEOUT_MS, resolveModelSourceFromEnv, assertModelEndpointAllowed, ModelEndpointNotAllowedError } from './model-source.js';
export type { ResolvedModelSource, ModelSourceConfig, ModelMetadata, ModelTier, ModelIdentity, ModelSelector } from './model-source.js';
export { MAX_OUTPUT_TOKENS_PER_REQUEST } from './model-source.js';
export { withModelFailover, resetModelCooldowns } from './model-failover.js';

export { buildSourceTools, buildMemoryTools, buildKnowledgeTools, buildDiffTool, isDefinitionLine, toolTextResult, finalizationTool, collectorTool, SOURCE_TOOL_NAMES, MEMORY_TOOL_NAMES, MEMORY_RECALL_MAX, KNOWLEDGE_TOOL_NAMES, KNOWLEDGE_READ_MAX } from './tools.js';
export type { FinalizationSpec, CollectorSpec, MemoryToolEntry, KnowledgeToolEntry } from './tools.js';

export { sumUsage } from './types.js';
export type {
  AgentRole,
  ModelPolicy,
  AgentBudget,
  ToolPolicy,
  EvidenceEntry,
  SourceProvider,
  InvocationStatus,
  InvocationResult,
  InvocationUsage,
} from './types.js';

// Downstream packages use pi types through here instead of depending on pi directly.
export { Type } from '@earendil-works/pi-ai';
export type { Static, TSchema, Model } from '@earendil-works/pi-ai';
export type { StreamFn, ThinkingLevel, AgentTool, AgentMessage } from '@earendil-works/pi-agent-core';

// Test helpers.
export { createFauxAgent, createRoutingFauxAgent, systemPromptOf } from './faux.js';
export type { FauxAgent, RoutingFauxAgent } from './faux.js';

export { languageInstruction, submittedTextLanguage } from './language.js';
export { buildSkillTool, skillIndexText, SKILL_LOAD_MAX, type SkillEntry } from './skills.js';
