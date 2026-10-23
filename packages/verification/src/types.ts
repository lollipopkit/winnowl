import type {
  AgentBudget,
  AgentMessage,
  AgentTool,
  InvocationUsage,
  Model,
  SourceProvider,
  StreamFn,
} from '@reviewbot/agent-pi';
import type { ChangeRelation } from '@reviewbot/domain';
import type { ConfirmationLevel, Effort, FindingCategory, Severity } from '@reviewbot/findings';
import type { PromptBundle } from '@reviewbot/prompts';

export interface VerifiableCandidate {
  id: string;
  claim: string;
  category: FindingCategory;
  suspectedSeverity: Severity;
  primaryAnchorText: string;
  changeRelationHypothesis: string;
  failureScenario?: string;
  /** File containing the anchor. */
  path?: string;
  /** Author's reply to the finding. Untrusted: only what the code confirms is accepted. */
  authorReply?: string;
}

export interface CommittableSuggestion {
  /** 1-based, inclusive, head-side lines. */
  startLine: number;
  endLine: number;
  /** Verbatim current head content of the range; checked before publishing to catch wrong line numbers. */
  originalText: string;
  replacement: string;
}

export interface VerificationVerdict {
  candidateId: string;
  decision: 'accept' | 'reject' | 'uncertain';
  introducedByChange: boolean;
  reachable: boolean;
  actionable: boolean;
  changeRelation: ChangeRelation;
  severity: Severity;
  confirmation: ConfirmationLevel;
  residualUncertainty: string[];
  /** Absent when the verifier did not finish. */
  rationale?: string;
  /** Does not affect presentation or the gate. */
  effort?: Effort;
  /** The verifier did not finish: nothing can be asserted (never assume no issue). */
  incomplete: boolean;
  /** e.g. `no finalization tool called`, `turn budget exhausted`, `error: <kind>`. */
  incompleteReason?: string;
  /** Differs from the primary model when a fallback was used; display/debugging only. */
  modelId?: string;
  /** Unvalidated: the publisher's `validateSuggestion` checks it and drops only the suggestion on mismatch. */
  suggestion?: CommittableSuggestion;
  usage?: InvocationUsage;
}

export interface RefutationResult {
  candidateId: string;
  decision: 'uphold' | 'dispute' | 'reject';
  arguments: string[];
  usage?: InvocationUsage;
}

export interface VerifyDeps {
  source: SourceProvider;
  model: Model<string>;
  /** Defaults to the verifier's model; a different one makes agreement mean something. */
  refuterModel?: { model: Model<string>; fallbackModels?: Model<string>[]; streamFn?: StreamFn };
  /** Same-tier fallbacks, tried in order when the primary fails after retries (not on rate limits). */
  fallbackModels?: Model<string>[];
  streamFn: StreamFn;
  bundles: { verifier: PromptBundle; refuter: PromptBundle };
  budget: AgentBudget;
  /** Read-only plugin evidence tools (e.g. exa/context7); results are untrusted data. */
  pluginTools?: AgentTool[];
  /** `run_command` to reproduce a claim; absent where commands cannot run. */
  commandTools?: AgentTool[];
  /** Aborts the in-flight call (the review was cancelled). */
  signal?: AbortSignal;
  /** `knowledge_read`: full text of rules / fact details listed in short form (all stages need it). */
  knowledgeTools?: AgentTool[];
  /** Repository rules and notes, appended after the system prompt (same as exploration). */
  standards?: string;
  /**
   * Session-reuse experiment: verify/refute fork from the exploration transcript, trading away
   * independent verification (confirmation bias). Empty: fresh context.
   */
  seedMessages?: AgentMessage[];
}

/** Input to findings.decidePublication. */
export interface VerifiedCandidate {
  verdict: VerificationVerdict;
  /** undefined: the refuter did not run. */
  refuterUpheld?: boolean;
  refutation?: RefutationResult;
  /** Verifier + refuter combined. */
  usage?: InvocationUsage;
  /** The model that actually produced the verdict (differs after a fallback); shown to readers. */
  modelId?: string;
}
