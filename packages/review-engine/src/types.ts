import type {
  AgentMessage,
  InvocationStatus,
  InvocationUsage,
  StreamFailureKind,
} from '@reviewbot/agent-pi';

export interface ReviewObligation {
  id: string;
  kind: string;
  description: string;
}

/**
 * Review plan given by code instead of the LLM map, for small changes only.
 * Serializable: travels into the sandbox with the executor spec.
 */
export interface PlannedScope {
  title: string;
  changeSummary: string;
  obligations: { kind: string; description: string }[];
  files: string[];
}

/**
 * What the previous review of the same PR left for a changed file.
 * - Not reviewed this round (unchanged): `note` is known context.
 * - Reviewed again (changed since): `note` may be stale; `roundDiff` is the change since then.
 */
export interface FileContext {
  path: string;
  note?: string;
  roundDiff?: string;
}

export interface ReviewScope {
  id: string;
  title: string;
  changeSummary: string;
  obligations: ReviewObligation[];
  /** Changed files of this scope; dig prefetches them into the prompt. Omitted = tool-only exploration. */
  files?: string[];
  /** Changed line ranges this split part must check line by line (focus.ts). Omitted = all changes in `files`. */
  focus?: ScopeFocus[];
  /**
   * Split part index (focus.ts). The title stays the same: the change summary lists each scope once.
   */
  part?: { index: number; total: number; /** Id of the pre-split scope (= id of part 1). */ sectionId: string };
  /**
   * Not planned by map; excluded from the change summary and walkthrough.
   * `remainder` = fallback for files map missed (remainder.ts); `planned` = fixed plan when map is skipped.
   */
  origin?: 'remainder' | 'planned';
}

/** Changed line range on the head side, inclusive. */
export interface ScopeFocus {
  path: string;
  startLine: number;
  endLine: number;
}

export interface Candidate {
  id: string;
  scopeId?: string;
  source: 'agent' | 'synthesis';
  claim: string;
  category: string;
  suspectedSeverity: string;
  path: string;
  primaryAnchorText: string;
  changeRelationHypothesis: string;
}

/**
 * Memory candidate proposed by the agent during review. Collected only, never persisted here:
 * it comes from the untrusted-diff loop, so persistence goes through the memory_propose job's sanitize/dedup/allowlist.
 */
export interface MemoryCandidate {
  kind: string;
  title: string;
  summary: string;
  body: string;
  selector?: string;
}

/**
 * Ecosystem fact verified with web tools during review (new versions, deprecations, replacements, breaking changes).
 * `sources` is filtered to URLs the plugin tools actually returned; applies cross-tenant only after human review.
 */
export interface ExternalFactCandidate {
  ecosystem: string;
  subject: string;
  versions?: string;
  claim: string;
  detail?: string;
  sources: string[];
}

export type ScopeStatus = 'complete' | 'incomplete' | 'blocked' | 'failed';

/** Every scope gets an outcome, even without candidates. */
export interface ScopeOutcome {
  scopeId: string;
  status: ScopeStatus;
  candidateIds: string[];
  exploredEntities: string[];
  /**
   * Files the exploration actually read (read_source / read_range, incl. subagents), recorded by the engine.
   * The scope's conclusions depend on them: if they change next round, the conclusions cannot be reused.
   * search_code hits do not count (only snippets were seen).
   */
  readPaths?: string[];
  /** Per changed file notes given by dig in complete_section. */
  fileNotes?: { path: string; summary: string }[];
  /** Walkthrough entry written by dig when map is skipped (orchestrator `walkthroughOf`). */
  walkthrough?: { title: string; summary: string };
  budgetExhausted: boolean;
  incompleteReason?: string;
  /**
   * Failure kind when dig ends on a model stream failure (same as `ReviewLedger.mapFailureKind`).
   * When map is skipped this is the only place the cause is recorded; without it the job retries
   * as an execution-plane fault within the gateway's cooldown window.
   */
  failureKind?: StreamFailureKind;
}

export interface ReviewLedger {
  scopes: ReviewScope[];
  scopeOutcomes: ScopeOutcome[];
  candidates: Candidate[];
  mapStatus: InvocationStatus;
  /** Cross-scope synthesis completion when that stage was attempted. */
  synthesisStatus?: InvocationStatus;
  /** Map failure kind (when mapStatus='error'), for attribution and retry decisions. */
  mapFailureKind?: StreamFailureKind;
  /** Raw map error message (truncated), which the failure kind loses. Logged only, never posted to the PR. */
  mapErrorMessage?: string;
  /** Why map did not finish (agent-pi incompleteReason). */
  mapIncompleteReason?: string;
  coverage: { scopesTotal: number; scopesComplete: number };
  /** Map + Dig + Synthesis total. */
  usage?: InvocationUsage;
  /** Per-stage usage; a stage without usage (e.g. faux model) is absent. */
  stageUsage?: { map?: InvocationUsage; dig?: InvocationUsage; synthesis?: InvocationUsage };
  /** Per-stage wall time (ms). dig covers the whole concurrent stage; stages not run are absent. */
  stageMs?: { map?: number; dig?: number; synthesis?: number };
  /** Tool outputs elided by context compaction across the three exploration stages; absent = none. */
  elidedToolResults?: number;
  /** In-loop memory candidates (when collectMemories is on; bounded). */
  memoryCandidates?: MemoryCandidate[];
  /** Ecosystem facts verified during review (with web plugins; bounded). */
  externalFacts?: ExternalFactCandidate[];
  /** Total `record_external_fact` calls; minus `externalFacts.length` = dropped for failed source checks. */
  externalFactsSubmitted?: number;
  /**
   * Final map+dig exploration transcript (finalization calls stripped), only with sessionReuse.
   * The orchestrator forks it as seedMessages into each candidate's verify/refute.
   */
  explorationTranscript?: AgentMessage[];
  /**
   * Superseded by a newer head mid-exploration; remaining scopes/synthesis did not run.
   * Coverage reflects the gap and usage still reflects what was spent (billed as usual).
   */
  cancelled?: boolean;
  /**
   * Scopes not run after the per-run cost breaker tripped (a skipped synthesis counts once).
   * Separate from `cancelled`: results are still published, and readers need to see why coverage is short.
   */
  costCappedScopes?: number;
  /**
   * Stages cut by their own wall-clock deadline. Must be distinguishable from model/gateway failures:
   * the ledger looks the same, but a failure should retry while a deadline should continue with partial results.
   */
  deadlineCutStages?: ('map' | 'dig' | 'synthesis')[];
}

/**
 * Progress report. `stage` is internal and only selects a user-facing sentence;
 * `done/total` is progress within the stage, absent when it has no countable units.
 * Best effort: a failed report must never affect the run's result.
 */
export interface ReviewProgress {
  stage: 'prepare' | 'map' | 'dig' | 'synthesis' | 'verify' | 'publish';
  done?: number;
  total?: number;
}
