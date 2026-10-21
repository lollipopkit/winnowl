import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { StreamFailureKind } from './failure.js';

export type AgentRole =
  | 'mapper'
  | 'reviewer'
  | 'synthesizer'
  | 'verifier'
  | 'refuter'
  | 'chat'
  | 'fixer'
  | 'planner'
  | 'pipeline-analyst';

export interface ModelPolicy {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
}

export interface AgentBudget {
  maxTurns: number;
  maxToolCalls: number;
}

export interface ToolPolicy {
  allowed: ReadonlySet<string>;
}

export interface EvidenceEntry {
  tool: string;
  argsDigest: string;
  isError: boolean;
  outputBytes: number;
  truncated: boolean;
  at: number;
}

export interface SourceProvider {
  listChangedFiles(): Promise<{ path: string; status: string; pureMove?: boolean }[]>;
  readFile(path: string): Promise<string | null>;
  searchCode(query: string): Promise<{ path: string; line: number; text: string }[]>;
  /**
   * Whole-word, case-sensitive identifier search; without it symbol tools fall back to `searchCode` plus filtering.
   * Wrappers of SourceProvider must forward it, or the less precise fallback is always used.
   */
  searchSymbol?(symbol: string): Promise<{ path: string; line: number; text: string }[]>;
}

export type InvocationStatus = 'complete' | 'incomplete' | 'error';

/** Token usage and cost summed over all turns of an invocation. */
export interface InvocationUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Prompt cache read/write tokens (0 if the provider does not report them). */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Subset of `outputTokens`; 0 if not reported. */
  reasoningTokens: number;
  turns: number;
}

/** The single usage summation; use it everywhere so new fields are never dropped on some path. */
export function sumUsage(...parts: (InvocationUsage | undefined)[]): InvocationUsage | undefined {
  const present = parts.filter((u): u is InvocationUsage => u !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    turns: a.turns + b.turns,
  }));
}

export interface InvocationResult<T = unknown> {
  status: InvocationStatus;
  /** Captured by the finalization tool; present when complete. */
  finalization?: T;
  finalizationTool?: string;
  /** Collector payloads (e.g. submit_finding), keyed by tool name. */
  collected: Record<string, unknown[]>;
  evidence: EvidenceEntry[];
  toolCalls: number;
  turns: number;
  usage?: InvocationUsage;
  incompleteReason?: string;
  errorMessage?: string;
  /** Set when status='error'. */
  failureKind?: StreamFailureKind;
  /** Tool results elided by context compaction; absent when none. */
  elidedToolResults?: number;
  /** Total attempts including retries and model fallbacks; `usage` sums all of them. */
  attempts?: number;
  /** Model that produced the result; differs from the requested one after a fallback, which must be shown to readers. */
  modelId?: string;
  /** Final transcript, finalization calls pruned; can seed the next stage via `seedMessages`. */
  transcript?: AgentMessage[];
}
