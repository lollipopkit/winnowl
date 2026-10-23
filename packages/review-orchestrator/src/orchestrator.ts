import {
  sumUsage as sumInvocationUsage,
  type AgentBudget,
  type AgentMessage,
  type AgentTool,
  type InvocationUsage,
  type Model,
  type SourceProvider,
  type StreamFailureKind,
  type StreamFn,
  type SkillEntry,
} from '@reviewbot/agent-pi';
import { meetsInlineThreshold, resolveAnchor } from '@reviewbot/anchor-resolver';
import {
  applyNoiseBudget,
  decidePublication,
  isHighRiskSeverity,
  rankScore,
  severityRank,
  shouldPublish,
  type ConfirmationLevel,
  type DemotionReason,
  type SuppressReason,
  type FindingCategory,
  type NoiseBudget,
  type PublicationDecision,
  type PublicationPlacement,
  type Severity,
} from '@reviewbot/findings';
import type { PromptBundle } from '@reviewbot/prompts';
import type { ProviderAnchor } from '@reviewbot/provider-contracts';
import {
  publishInlineComment,
  publishReviewBatch,
  publishSummaryComment,
  renderChangeSummary,
  renderFindingComment,
  renderReviewSummary,
  type AgentPromptGroup,
  type PublishContext,
} from '@reviewbot/publisher';
import {
  createCostBreaker,
  reviewStandardsContext,
  runReviewPipeline,
  type Candidate,
  type ExplorationScope,
  type FileContext,
  type MemoryCandidate,
  type ExternalFactCandidate,
  type PlannedScope,
  type ReviewLedger,
  type ReviewProgress,
  type StageClock,
  type SubmoduleBump,
} from '@reviewbot/review-engine';
import {
  isSlopKind,
  slopDisposition,
  suppressedByThreshold,
  type ProfileSettings,
} from '@reviewbot/review-profile';
import { verifyCandidateWithVotes, type VerificationVerdict } from '@reviewbot/verification';
import { getTracer, recordReview, withSpan } from '@reviewbot/telemetry';
import { changeRelationCanBlockMerge, type ChangeRequestRef } from '@reviewbot/domain';
import {
  coveredFilesOf,
  coveredPathsOf,
  normaliseReviewPath,
  plannedPathsOf,
  sectionCoverage,
  unverifiedIdsOf,
} from './coverage.js';
import { coerceCategory, coerceSeverity } from './coerce.js';
import {
  claimSimilarity,
  mergeSameDefect,
  nearDuplicateIds,
  tokenDiceStrategy,
  NEAR_DUP_THRESHOLD,
  type DedupCandidate,
  type DedupStrategy,
  type ClaimSimilarityFn,
} from './dedup.js';
import type { FindingMatcher, MatchMethod, MatchPrior } from './match.js';
import {
  reconcilePriorBlocking,
  type PriorBlockingFinding,
  type ResolutionResult,
} from './resolution.js';
import { validateSuggestion } from './suggestion.js';
import { walkthroughOf } from './walkthrough.js';
import { makeSemaphore } from './semaphore.js';

/**
 * Active finding eligible for stale archival. Without this, findings nobody explicitly
 * resolves/retracts/dismisses stay active forever and overflow the cross-round match cap.
 */
export interface StaleCandidate {
  findingId: string;
  fingerprint: string;
  /** Anchored file; when missing the finding is not archived (cannot tell whether it changed). */
  path?: string;
  /** Head sha of the round that last reported it; when missing the finding is not archived. */
  lastSeenHeadSha?: string;
}

/** Model for the `unitIndex`-th work unit of a stage. Exploration stages are forwarded to the engine. */
export type OrchestratorStageModelResolver = (
  stage: 'map' | 'dig' | 'synthesis' | 'verify' | 'refute',
  unitIndex: number,
) => { model: Model<string>; fallbackModels?: Model<string>[]; streamFn?: StreamFn } | undefined;

/**
 * Active prior finding on a file skipped this round (unchanged content and standards).
 * It cannot be reproduced this round, so it is carried into the summary and agent prompts.
 */
export interface CarriedFinding {
  findingId: string;
  fingerprint: string;
  category: string;
  claim: string;
  severity: string;
  path: string;
  line?: number;
  effort?: string;
}

/**
 * Previously published non-blocking finding on a file re-reviewed this round. Not being reported
 * again does not mean fixed (exploration is random): changed file -> targeted LLM check;
 * unchanged file -> still open without an LLM call.
 */
export interface OpenPriorFinding extends CarriedFinding {
  lastSeenHeadSha?: string;
  anchorText?: string;
}

/** A finding the user dismissed on this change request. */
export interface DismissedFindingRef {
  fingerprint: string;
  weakFingerprint?: string;
  category: string;
  claim: string;
  path?: string;
}

/**
 * Fast path: strong/weak fingerprint match. Stable path: same file + category + similar claim,
 * because the LLM rewords claims every round and fingerprints drift.
 */
function isDismissed(
  dismissed: readonly DismissedFindingRef[] | undefined,
  candidate: {
    path: string;
    category: string;
    claim: string;
    fingerprint: string | undefined;
    weakFingerprint: string | undefined;
  },
  simFn: ClaimSimilarityFn,
): boolean {
  if (!dismissed || dismissed.length === 0) return false;
  return dismissed.some((d) => {
    if (candidate.fingerprint !== undefined && d.fingerprint === candidate.fingerprint) return true;
    if (candidate.weakFingerprint !== undefined && d.weakFingerprint === candidate.weakFingerprint)
      return true;
    if (d.category !== candidate.category) return false;
    if (d.path !== undefined && d.path !== candidate.path) return false;
    return simFn(d.claim, candidate.claim) >= NEAR_DUP_THRESHOLD;
  });
}

const reviewTracer = getTracer('review-orchestrator');

/**
 * Exploration did not complete (model/gateway failure). Retryable so the job is retried instead of
 * approving a "0 findings" PR. classifyJobError treats `deadlineCut` and failureKind
 * content_filter / context_overflow as terminal (still never an approve).
 */
export class ReviewIncompleteError extends Error {
  readonly retryable = true;
  /**
   * Selects the retry tier in classifyJobError. `retryable` stays true as a fallback for paths
   * that do not know failureKind: never let a failed exploration pass as a clean PR.
   */
  readonly failureKind?: StreamFailureKind;
  /** Truncated raw stream error; logged only, never posted to the PR. */
  readonly failureDetail?: string;
  /**
   * A stage wall clock (`ledger.deadlineCutStages`) expired and not a single candidate came out.
   * Terminal: a retry spends the same wall clock on the same model and most likely ends the same
   * way. Takes precedence over `failureKind` in classifyJobError, because aborting a stream at the
   * deadline itself surfaces as a timeout/unknown stream failure.
   */
  readonly deadlineCut?: boolean;
  constructor(
    message: string,
    opts: { failureKind?: StreamFailureKind; failureDetail?: string; deadlineCut?: boolean } = {},
  ) {
    super(message);
    this.name = 'ReviewIncompleteError';
    if (opts.failureKind !== undefined) this.failureKind = opts.failureKind;
    if (opts.failureDetail !== undefined) this.failureDetail = opts.failureDetail;
    if (opts.deadlineCut === true) this.deadlineCut = true;
  }
}

export interface ReviewOrchestratorDeps {
  source: SourceProvider;
  model: Model<string>;
  /** Same-tier fallback models, tried in order when the primary fails (not on rate limits). */
  fallbackModels?: Model<string>[];
  streamFn: StreamFn;
  bundles: {
    mapper: PromptBundle;
    reviewer: PromptBundle;
    synthesizer: PromptBundle;
    verifier: PromptBundle;
    refuter: PromptBundle;
  };
  budget: AgentBudget;
  newId: () => string;
  changeSummary?: string;
  knowledgeContext?: string;
  /** AGENTS.md / CLAUDE.md content: background data, not rules. */
  repositoryGuidance?: string;
  lfsPointerPaths?: readonly string[];
  submoduleBumps?: readonly SubmoduleBump[];
  /** Deterministic dependency vulnerability evidence (osv-scanner), injected into map/dig. */
  securityEvidence?: string;
  /**
   * Dependency findings built from deterministic CVE evidence. Merged at publish time without
   * map/dig or LLM verify: the verifier cannot check an advisory from code, the evidence is the proof.
   */
  dependencyFindings?: DependencyFindingInput[];
  /** Agent memory index; soft reference, not instructions. */
  memoryContext?: string;
  ecosystemFacts?: string;
  /** PR/issue image descriptions, already wrapped as UNTRUSTED DATA. */
  imageContext?: string;
  memoryTools?: AgentTool[];
  /** `knowledge_read`: full text of rules / fact details listed in short form (all stages need it). */
  knowledgeTools?: AgentTool[];
  pluginTools?: AgentTool[];
  /** `run_command` for dig and verify; absent where commands cannot run. */
  commandTools?: AgentTool[];
  /** Public source URLs returned by plugin tools; `record_external_fact` is enabled only with it. */
  lookupSources?: ReadonlySet<string>;
  collectMemories?: boolean;
  exploration?: ExplorationScope;
  /** Bounded verify concurrency; default 4. */
  verifyConcurrency?: number;
  /** Independent verify votes per candidate, conservatively aggregated; default 1. Cost scales by N. */
  verifyVotes?: number;
  /**
   * Per-review cost cap in USD; <=0 or omitted = unlimited. Only bounds the verify fan-out.
   * Candidates past the cap are neither verified nor published (`costCappedCandidates`).
   */
  costCapUsd?: number;
  /**
   * Verify wall clock, counted from the first candidate's verification (verify overlaps dig).
   * Remaining candidates are dropped like the cost cap, counted separately.
   */
  verifyBudgetMs?: number;
  /**
   * Per-stage model selection; verify/refute are consumed here, the rest forwarded to the engine.
   * Omitted = `deps.model` everywhere. A verify work unit is one vote (candidate index x votes +
   * vote index), so round-robin spreads one candidate's votes across different models.
   */
  stageModel?: OrchestratorStageModelResolver;
  stageBudgetMs?: { map?: number; dig?: number; synthesis?: number };
  /** Clock behind `stageBudgetMs`, forwarded to the engine. Omitted = wall clock (tests inject a manual one). */
  stageClock?: StageClock;
  /**
   * Changed files still unexplored when this round starts (cross-round coverage ledger).
   * Used to prioritise uncovered scopes, and minus this round's coverage gives the PR-level
   * uncovered set that approve and the gate use. Omitted = single-round accounting.
   */
  uncoveredPaths?: readonly string[];
  /** Files deferred to a later round; counted separately and still block approve. */
  deferredPaths?: readonly string[];
  selectedPaths?: readonly string[];
  runConfig?: { source: 'repository' | 'panel' | 'default'; profile: string };
  commitRange?: { base: string; head: string };
  /** Unchanged files reviewed under this exact contract; readable context, not review targets. */
  priorReviewedPaths?: readonly string[];
  /** Code-derived review plan for small changes; skips the LLM map. */
  plannedScopes?: readonly PlannedScope[];
  fileContext?: readonly FileContext[];
  filePatches?: Readonly<Record<string, string>>;
  skills?: readonly SkillEntry[];
  /** Opaque current states used to persist only files from completed scopes. */
  reviewFileStates?: readonly { path: string; materialDigest: string }[];
  reviewContractDigest?: string;
  /** Best effort: call sites catch errors so a failed UI update never fails the review. */
  onProgress?: (p: ReviewProgress) => void;
  /** Bounded dig concurrency; default 4. */
  digConcurrency?: number;
  digForkFromMap?: boolean;
  /** Concurrency limits of the dig `investigate` tool; omitted = tool not offered. */
  subagents?: { maxTasks: number; maxConcurrency: number; budget: AgentBudget };
  /**
   * Merge map+dig into one session and fork its transcript for each candidate's verify/refute
   * after exploration (no dig->verify overlap). Off by default.
   */
  sessionReuse?: boolean;
  /** Claim similarity (default token-Dice); also backs the post-verify fold when dedupStrategy is set. */
  claimSimilarity?: ClaimSimilarityFn;
  /**
   * Pre-verify dedup strategy; default tokenDiceStrategy. Batch strategies wait for all
   * candidates before verifying, giving up the dig->verify overlap.
   */
  dedupStrategy?: DedupStrategy;
  /** Output language for user-visible text; omitted / `en` = English. */
  language?: string;
  /** Bot mention (e.g. `@winnowl`); adds a "ask the bot to fix" hint to the summary. */
  botMention?: string;
  /** Approve the PR when there is no blocking finding; default true. */
  autoApprove?: boolean;
  /** Severities of confirmed defects that block (request changes); default critical/high/medium. */
  blockOnSeverity?: readonly Severity[];
  /**
   * Whether pre-existing issues count as blocking; default false. Applies to both the matrix
   * decision and the attribution re-check that exits prior reconciliation; both must agree or a
   * pre-existing issue re-enters the gate as still-present.
   */
  blockPreexisting?: boolean;
  suggestionsEnabled?: boolean;
  /** Max replaced lines per suggestion; default from validateSuggestion (10). */
  suggestionMaxLines?: number;
  /**
   * Fold findings over the inline quota into the summary (true, default) or drop them (false).
   * Only quota overflow is dropped; other demotion reasons are unaffected.
   */
  summaryOverflow?: boolean;
  showUnverifiedRisks?: boolean;
  /** List of suppressed/deduplicated items for auditing; default off. */
  showSuppressedDetails?: boolean;
  /** Minimum confirmation level for inline publication; omitted = no extra tightening. */
  minConfirmation?: ConfirmationLevel;
  /**
   * Position in a PR stack. A stacked PR's diff is against the layer below; the summary states
   * that so a short review is not mistaken for a missed one.
   */
  stack?: { position?: number; size?: number; onNumber?: number; baseRef?: string };
  /**
   * Upsert the summary into the CR description; inline comments then go out as one batch review.
   * Omitted = summary as a comment / review body.
   */
  updateSummaryDescription?: (summaryMarkdown: string) => Promise<void>;
  /**
   * Fingerprints of previously reported active findings. A match is `persisted` (folded into the
   * summary, not re-posted inline); otherwise `new`. Omitted/empty = all new.
   */
  priorFingerprints?: ReadonlySet<string>;
  /**
   * Cross-round identity matching; enabled only when both are set, otherwise exact strong-fingerprint
   * matching. Fingerprints contain LLM-rewritten claims and code windows, so they drift across rounds.
   */
  findingMatcher?: FindingMatcher;
  priorFindings?: readonly MatchPrior[];
  carriedFindings?: readonly CarriedFinding[];
  openPriorFindings?: readonly OpenPriorFinding[];
  /**
   * Findings dismissed via `@bot ignore`: fully suppressed, only listed in the summary's suppressed
   * section. Structured records instead of fingerprints because both fingerprints drift across rounds.
   */
  dismissedFindings?: readonly DismissedFindingRef[];
  /** Semantic fingerprint (includes repositoryId); omitted = no incremental reconciliation. */
  computeFingerprint?: (input: {
    category: FindingCategory;
    claim: string;
    primaryAnchorText: string;
    /** Anchor file; dependency vulnerability findings have none. */
    path?: string;
  }) => string;
  /**
   * Weak fingerprint without the claim wording; dismissal matching needs it since the strong one
   * changes whenever the LLM rewords. Omitted = strong fingerprint only.
   */
  computeWeakFingerprint?: (input: {
    category: FindingCategory;
    primaryAnchorText: string;
    path?: string;
  }) => string;
  /**
   * Prior active blocking findings (auto-approve gate). If not reproduced this round they are checked
   * for a fix (file-changed prefilter + targeted LLM); unconfirmed fixes count as blocking.
   * Omitted = no gate. See resolution.ts.
   */
  priorBlockingFindings?: readonly PriorBlockingFinding[];
  /** Max targeted gate checks; default 20. */
  resolutionMaxVerify?: number;
  /**
   * Files changed between a sha and this head, for the gate prefilter.
   * Omitted / null = always use the LLM check (do not guess).
   */
  filesChangedSince?: (sinceSha: string) => Promise<ReadonlySet<string> | null>;
  /**
   * Active findings not seen for `review.stale_rounds` rounds, pre-filtered by the caller. Here only
   * the final checks apply: file changed, and not reported again this round. Omitted = disabled.
   */
  staleCandidates?: readonly StaleCandidate[];
  /** `off` suppresses preexisting-unrelated findings; `summary` (default) / `issue` put them in the summary. */
  reportPreexistingUnrelated?: 'summary' | 'issue' | 'off';
  /**
   * Changed files excluded by path filters. Listed in the summary; findings anchored in them are
   * dropped before publishing (agents can still read them via read_source).
   */
  ignoredFiles?: ({ path: string; glob: string } | { path: string; reason: 'generated' | 'vendored' | 'binary' | 'lfs-pointer' | 'submodule' })[];

  /** Source lines at the head revision (for anchor resolution). */
  readHeadLines: (path: string) => Promise<string[]>;
  /** Whether a 1-based line is changed in this revision. */
  isChangedLine: (path: string, line: number) => boolean;

  publishContext: PublishContext;
  publishTarget: {
    tenantId: string;
    repositoryId: string;
    changeRequest: ChangeRequestRef;
    changeRequestId: string;
    revisionId: string;
    revisionSha: string;
    providerHostId: string;
    expectedHeadSha: string;
    /**
     * Publish idempotency scope; default one review per revision. Manual `@bot review` passes the
     * job id so retries stay idempotent while a new command posts a new review.
     */
    idempotencyScope?: string;
  };
  noiseBudget: NoiseBudget;
  /**
   * Omitted = no profile suppression or slop handling. Profiles only affect noise thresholds and
   * slop folding, never correctness/security verification standards.
   */
  profile?: ProfileSettings;
  /**
   * Cooperative cancellation (a newer head superseded this job), polled before every paid step.
   * Does not throw: usage so far is still returned and billed. Cancelled reviews are not published.
   * In the sandbox it stats a workspace sentinel file (no DB). Called per candidate; implementations
   * must throttle.
   */
  isCancelled?: () => boolean | Promise<boolean>;
}

/** Deterministic CVE finding input; claim already localised. */
export interface DependencyFindingInput {
  claim: string;
  /** Manifest/lock path; shown for location, never anchored inline. */
  path: string;
  severity: VerificationVerdict['severity'];
  advisoryId: string;
  /** Introduced by this change (manifest touched by this PR). */
  introduced: boolean;
  /** Introduced and severity meets the `reviews.dependency_gate` threshold. */
  blocking: boolean;
}

export interface CodeContext {
  startLine: number;
  lines: string[];
}

const CONTEXT_LINES = 3;
const CONTEXT_MAX = 15;

/** `null` when the anchor is outside the file (deleted or moved). */
function codeContext(lines: string[], from: number, to: number): CodeContext | null {
  if (from < 1 || from > lines.length) return null;
  const start = Math.max(1, from - CONTEXT_LINES);
  const end = Math.min(lines.length, to + CONTEXT_LINES, start + CONTEXT_MAX - 1);
  return { startLine: start, lines: lines.slice(start - 1, end) };
}

export interface ProcessedFinding {
  candidateId: string;
  claim: string;
  path: string;
  /**
   * `path` is readable at head. The LLM path is untrusted (hallucinated paths have appeared); an
   * unreadable path is omitted from output so agents are not told to create files there.
   * Check is `readHeadLines(path).length > 0`, so files deleted by the change also count as missing.
   */
  pathExists: boolean;
  category: FindingCategory;
  /** Anchor text (code window), used for the semantic fingerprint. */
  primaryAnchorText: string;
  /**
   * Final placement after the demotion chain; differs from `decision.placement` when demoted
   * (reasons in `demotions`). Status and kind are decided by `decision`.
   */
  placement: PublicationPlacement;
  decision: PublicationDecision;
  verdict: VerificationVerdict;
  fingerprint?: string;
  /** `persisted` = reported before and reproduced (folded, not re-posted inline). */
  incremental?: 'new' | 'persisted';
  /** Prior finding id matched across rounds; persistence reuses that row instead of inserting. */
  matchedFindingId?: string;
  matchMethod?: MatchMethod;
  anchor?: ProviderAnchor;
  refuterUpheld?: boolean;
  publicationId?: string;
  /** Slop: non-blocking, folded into the summary, not counted as a confirmed bug. */
  slop?: boolean;
  /** Not shown at all; `suppressReason` says why. */
  suppressed?: boolean;
  suppressReason?: SuppressReason;
  /** Head lines around the anchor, as reviewed. */
  codeContext?: CodeContext;
  /** The validated committable suggestion, when one was posted. */
  suggestion?: { startLine: number; endLine: number; replacement: string };
  /** Reasons for demotion from inline to folded sections, in order. */
  demotions?: DemotionReason[];
}

/**
 * Agent prompt group. Must mirror the summary's folded sections' filters, or a finding lands in
 * different groups in the summary and the agent prompt.
 */
function promptGroup(f: ProcessedFinding): AgentPromptGroup {
  if (isNit(f)) return 'nitpick';
  if (f.placement === 'inline') return 'inline';
  return f.verdict.changeRelation === 'preexisting-unrelated' ? 'preexisting' : 'additional';
}

/** Kind is decided by the matrix; demotion does not change it. */
function isNit(f: ProcessedFinding): boolean {
  return f.decision.kind === 'nit';
}

/** Omit the location when the path is unreadable at head; a line without a path is useless. */
function promptWhere(f: ProcessedFinding): { path?: string; line?: number } {
  if (!f.pathExists) return {};
  return { path: f.path, ...(f.anchor ? { line: f.anchor.line } : {}) };
}

function isConfirmed(f: ProcessedFinding): boolean {
  return f.decision.status === 'confirmed';
}

function unconfirmedSection(f: ProcessedFinding): 'unverified-risks' | 'low-evidence' {
  return isHighRiskSeverity(f.verdict.severity) ? 'unverified-risks' : 'low-evidence';
}

/** No severity badge: that would read as a conclusion. */
function unconfirmedLine(f: ProcessedFinding): string {
  return f.pathExists ? `${f.claim} (${f.path})` : f.claim;
}

function summaryEntry(f: ProcessedFinding): {
  severity: string;
  claim: string;
  path?: string;
  demotions?: string[];
  blocking?: boolean;
  effort?: string;
  line?: number;
} {
  return {
    severity: f.verdict.severity,
    ...(f.anchor?.line !== undefined ? { line: f.anchor.line } : {}),
    ...(f.verdict.effort ? { effort: f.verdict.effort } : {}),
    claim: f.claim,
    ...(f.pathExists ? { path: f.path } : {}),
    ...(f.demotions && f.demotions.length > 0 ? { demotions: f.demotions } : {}),
    ...(f.decision.blocking ? { blocking: true } : {}),
  };
}

export interface ReviewOutcome {
  candidateCount: number;
  findings: ProcessedFinding[];
  coverage: { scopesTotal: number; scopesComplete: number };
  /**
   * Cross-round coverage ledger:
   * - `coveredPaths`: files covered by scopes completed this round (written to `pr_coverage`).
   * - `unreachedPaths`: planned but never explored (cut by deadline/cost, or the scope reported itself not complete); blocks approve and the gate.
   * - `unplannedPaths`: claimed by no scope yet; also blocks approve.
   * Absent means unknown (no ledger, or map gave no `files`), which differs from an empty array.
   */
  coveredPaths?: string[];
  coveredFiles?: { path: string; materialDigest: string; dependencies?: string[]; note?: string }[];
  reviewContractDigest?: string;
  unreachedPaths?: string[];
  unplannedPaths?: string[];
  deferredPaths?: string[];
  /** Scopes that did not complete, with why (`not run` = cut before starting); for diagnosis only. */
  incompleteScopes?: { title: string; status: string; reason?: string }[];
  walkthrough?: { title: string; summary: string }[];
  reviewEvent?: 'comment' | 'approve' | 'request-changes';
  /** Blocking items on the gate (this round + unfixed prior). */
  blockingCount?: number;
  publishedInline: number;
  /**
   * Whether results appear on the PR as a review or comment (including idempotent replays).
   * A comment-only review with nothing to say is not posted.
   */
  resultsPosted?: boolean;
  publishedSummary?: boolean;
  usage?: InvocationUsage;
  /** Usage per stage; `verify` sums Verifier+Refuter over candidates. */
  stageUsage?: {
    map?: InvocationUsage;
    dig?: InvocationUsage;
    synthesis?: InvocationUsage;
    verify?: InvocationUsage;
  };
  /**
   * Wall clock per stage (ms). `verifyTail` is verify time after exploration ended (the overlap is
   * counted under dig); `publish` is the whole publish step.
   */
  stageMs?: Record<string, number>;
  /** Tool outputs elided during exploration (>0 = an invocation approached the context window). */
  elidedToolResults?: number;
  memoryCandidates?: MemoryCandidate[];
  /** Ecosystem facts with verified sources; applied only after human review. */
  externalFacts?: ExternalFactCandidate[];
  /** Total `record_external_fact` calls, including discarded ones. */
  externalFactsSubmitted?: number;
  /** Fingerprints of prior findings confirmed fixed. */
  resolvedFingerprints?: string[];
  /** Same, by finding id: fingerprints drift, so lookup by fingerprint may pick the wrong row. */
  resolvedFindingIds?: string[];
  /** Prior blocking findings still unfixed; counted as blocking. */
  unresolvedPriorBlocking?: ResolutionResult[];
  /** Prior findings judged no longer active (lifecycle 'stale'); reversible when reported again. */
  staleFindingIds?: string[];
  /** Full gate reconciliation breakdown, so `not-applicable` drops are observable. */
  priorReconcile?: { total: number; stillPresent: number; resolved: number; notApplicable: number };
  /**
   * Gate rows merged as rewordings of the same defect. Display only; >0 means cross-round matching
   * missed in an earlier round.
   */
  unresolvedDuplicatesMerged?: number;
  /** Prior findings cut by the cross-round match cap; they can only reappear as new rows. */
  priorMatchTruncated?: number;
  /** Candidates not verified because the cost cap hit; >0 = incomplete results. */
  costCappedCandidates?: number;
  /** Scopes (incl. skipped synthesis) cut by the cost cap during exploration. */
  costCappedScopes?: number;
  /** Candidates not verified because the verify wall clock expired. */
  deadlineCappedCandidates?: number;
  /**
   * Superseded by a newer head; nothing published. `usage` is still billable, but callers must skip
   * post-publish actions (reconciliation, issues, proposals) on incomplete results.
   */
  cancelled?: boolean;
  /** Rendered committable suggestions and rejection reasons. */
  suggestions?: { published: number; rejected: Record<string, number> };
}

export interface Staged {
  candidate: Candidate;
  verdict: VerificationVerdict;
  refuterUpheld?: boolean;
  decision: PublicationDecision;
  anchor?: ProviderAnchor;
  rank: number;
  /** See `ProcessedFinding.pathExists`. */
  pathExists: boolean;
  usage?: InvocationUsage;
}

/**
 * Exploration + verification output, fully JSON-serializable. Produced by `produceReview` (may run in
 * the sandbox: no DB/token) and consumed by `publishReview` on the control plane.
 */
export interface ProducedReview {
  staged: Staged[];
  ledger: ReviewLedger;
  /**
   * Candidates skipped by a capacity limit (cost cap / verify deadline / cancellation). Not the
   * complement of `staged`, which also excludes dedup-folded candidates already covered by a
   * survivor; the coverage ledger needs the distinction.
   */
  unverifiedCandidateIds?: string[];
  costCappedCandidates?: number;
  deadlineCappedCandidates?: number;
  /** Superseded by a newer head; publishReview never publishes it. */
  cancelled?: boolean;
  /** See `ReviewOutcome.stageMs`. */
  verifyTailMs?: number;
}

/**
 * `cap <= 0` or omitted = unlimited; reaching the cap trips it.
 * Faux models emit no usage, so the cap cannot be integration-tested; this pure rule is unit-tested.
 */
export function overCostCapUsd(spentUsd: number, capUsd: number | undefined): boolean {
  return (capUsd ?? 0) > 0 && spentUsd >= (capUsd as number);
}

const sumUsage = (parts: (InvocationUsage | undefined)[]): InvocationUsage | undefined =>
  sumInvocationUsage(...parts);

/**
 * Stage one candidate: verify (Verifier+Refuter) -> anchor resolution -> publication matrix -> rank.
 * Also used for new defects found during gate reconciliation, which must go through the same path
 * rather than inherit the old finding's identity. Quotas, cancellation, cost cap and concurrency are
 * the caller's concern.
 */
export async function stageCandidate(
  deps: ReviewOrchestratorDeps,
  candidate: Candidate,
  opts: { seedMessages?: AgentMessage[] } = {},
): Promise<Staged> {
  const category = coerceCategory(candidate.category);
  const verified = await withSpan(
    reviewTracer,
    'review.verify',
    () =>
      verifyCandidateWithVotes(
        {
          source: deps.source,
          model: deps.model,
          ...(deps.fallbackModels ? { fallbackModels: deps.fallbackModels } : {}),
          streamFn: deps.streamFn,
          bundles: { verifier: deps.bundles.verifier, refuter: deps.bundles.refuter },
          budget: deps.budget,
          ...(deps.pluginTools !== undefined ? { pluginTools: deps.pluginTools } : {}),
          ...(deps.commandTools !== undefined ? { commandTools: deps.commandTools } : {}),
          ...(deps.knowledgeTools !== undefined ? { knowledgeTools: deps.knowledgeTools } : {}),
          ...(reviewStandardsContext(deps) ? { standards: reviewStandardsContext(deps) } : {}),
          ...(opts.seedMessages && opts.seedMessages.length > 0
            ? { seedMessages: opts.seedMessages }
            : {}),
        },
        {
          id: candidate.id,
          claim: candidate.claim,
          category,
          suspectedSeverity: coerceSeverity(candidate.suspectedSeverity),
          primaryAnchorText: candidate.primaryAnchorText,
          changeRelationHypothesis: candidate.changeRelationHypothesis,
          path: candidate.path,
        },
        Math.max(1, deps.verifyVotes ?? 1),
        // Work unit is the vote index, so every candidate gets the same cross-model panel.
        deps.stageModel ? (voteIndex, stage) => deps.stageModel!(stage, voteIndex) : undefined,
      ),
    { 'review.category': category, 'review.candidate': candidate.id },
  );

  const lines = await deps.readHeadLines(candidate.path);
  const resolution = resolveAnchor({
    anchor: {
      path: candidate.path,
      revision: 'head',
      focusText: candidate.primaryAnchorText,
      prefixLines: [],
      suffixLines: [],
    },
    fileLines: lines,
    revisionSha: deps.publishTarget.revisionSha,
    isChangedLine: (line) => deps.isChangedLine(candidate.path, line),
  });

  const decision = decidePublication({
    severity: verified.verdict.severity,
    category,
    confirmation: verified.verdict.confirmation,
    changeRelation: verified.verdict.changeRelation,
    decision: verified.verdict.decision,
    actionable: verified.verdict.actionable,
    anchorUnique: resolution.unique,
    anchorScore: resolution.score,
    refuterUpheld: verified.refuterUpheld ?? false,
    ...(deps.minConfirmation !== undefined ? { minConfirmation: deps.minConfirmation } : {}),
    ...(deps.blockPreexisting !== undefined ? { blockPreexisting: deps.blockPreexisting } : {}),
    ...(deps.blockOnSeverity !== undefined ? { blockOnSeverity: deps.blockOnSeverity } : {}),
  });

  const anchor: ProviderAnchor | undefined = meetsInlineThreshold(resolution)
    ? { path: candidate.path, side: 'head', line: resolution.lineStart }
    : undefined;

  return {
    candidate,
    verdict: verified.verdict,
    ...(verified.refuterUpheld !== undefined ? { refuterUpheld: verified.refuterUpheld } : {}),
    decision,
    // readHeadLines returns [] for a missing file; an empty file is [''].
    pathExists: lines.length > 0,
    ...(anchor ? { anchor } : {}),
    ...(verified.usage ? { usage: verified.usage } : {}),
    rank: rankScore({
      severity: verified.verdict.severity,
      confirmation: verified.verdict.confirmation,
      changeRelation: verified.verdict.changeRelation,
      actionable: verified.verdict.actionable,
      anchorScore: resolution.score,
    }),
  };
}

/**
 * Exploration + verification, the sandbox-safe half: Map -> Dig -> Synthesis -> verify/refute ->
 * anchors -> decisions. Uses only source/streamFn/plugin/memory, never DB/GitHub token/KMS; the
 * output is serializable and published by publishReview.
 */
export async function produceReview(deps: ReviewOrchestratorDeps): Promise<ProducedReview> {
  // Verify pool overlapping dig: each candidate is verified as soon as it is produced. Every
  // candidate is verified; tiers only change model and concurrency, never coverage.
  const sem = makeSemaphore(Math.max(1, deps.verifyConcurrency ?? 4));
  const simFn = deps.claimSimilarity ?? claimSimilarity;
  // Same similarity signal as the post-verify fold, so no new false-merge surface.
  const dedupStrategy = deps.dedupStrategy ?? tokenDiceStrategy(simFn, NEAR_DUP_THRESHOLD);
  const incrementalIsDup = dedupStrategy.kind === 'incremental' ? dedupStrategy.isDuplicate : null;
  const batchDedupe = dedupStrategy.kind === 'batch' ? dedupStrategy.dedupe : null;
  let preVerifyDedupCount = 0;
  /*
   * Per-review cost cap, shared by verify (checked per candidate) and exploration (passed to the
   * engine, checked per scope): turn limits alone do not stop a non-converging model.
   * Candidates past the cap are neither verified nor published and are counted, never silently cut.
   */
  const costCapUsd = deps.costCapUsd ?? 0;
  const costBreaker = createCostBreaker(costCapUsd);
  let costCappedCandidates = 0;
  /*
   * Verify wall clock starts at the first candidate: verify overlaps dig, so starting at review start
   * would charge exploration time to verify. Expired candidates follow the cost-cap path.
   */
  const verifyBudgetMs = deps.verifyBudgetMs ?? 0;
  let verifyDeadlineAt = 0;
  let deadlineCappedCandidates = 0;
  /*
   * Candidates cut by a capacity limit (cost/deadline/cancel). The coverage ledger must tell them apart
   * from dedup-folded ones: the former leave a file's results incomplete, the latter are covered.
   */
  const unverifiedCandidateIds = new Set<string>();
  const overVerifyDeadline = (): boolean => {
    if (verifyBudgetMs <= 0) return false;
    if (verifyDeadlineAt === 0) {
      verifyDeadlineAt = Date.now() + verifyBudgetMs;
      return false;
    }
    return Date.now() >= verifyDeadlineAt;
  };
  // Sticky once observed, so later candidates skip the check.
  let cancelled = false;
  const checkCancelled = async (): Promise<boolean> => {
    if (cancelled) return true;
    cancelled = deps.isCancelled ? await deps.isCancelled() : false;
    return cancelled;
  };
  const stagedTasks: Promise<Staged | null>[] = [];
  /*
   * Verify progress total is the number of candidates queued so far, not the final count: verify
   * overlaps dig and the final count is only known after exploration.
   */
  let verifyStarted = 0;
  let verifyDone = 0;
  const reportVerify = (): void => {
    try {
      deps.onProgress?.({ stage: 'verify', done: verifyDone, total: verifyStarted });
    } catch {
      /* best effort */
    }
  };
  // Session reuse: holds the map+dig transcript once exploration ends; read lazily by stageOne as the
  // verify/refute fork seed (a holder because stageOne is defined before it is set).
  const explorationSeed: { current?: AgentMessage[] } = {};
  const stageOne = async (candidate: Candidate): Promise<Staged | null> => {
    // Check before taking a semaphore slot to avoid queueing for a slot that will be dropped.
    if (costBreaker.tripped()) {
      costCappedCandidates += 1;
      unverifiedCandidateIds.add(candidate.id);
      return null;
    }
    if (overVerifyDeadline()) {
      deadlineCappedCandidates += 1;
      unverifiedCandidateIds.add(candidate.id);
      return null;
    }
    if (await checkCancelled()) {
      unverifiedCandidateIds.add(candidate.id);
      return null;
    }
    verifyStarted += 1;
    reportVerify();
    await sem.acquire();
    try {
      // The queue can wait behind calls that consume the shared review budget or
      // exhaust the verification window. Recheck after admission before spending.
      if (costBreaker.tripped()) {
        costCappedCandidates += 1;
        unverifiedCandidateIds.add(candidate.id);
        return null;
      }
      if (overVerifyDeadline()) {
        deadlineCappedCandidates += 1;
        unverifiedCandidateIds.add(candidate.id);
        return null;
      }
      if (await checkCancelled()) {
        unverifiedCandidateIds.add(candidate.id);
        return null;
      }
      const staged = await stageCandidate(deps, candidate, {
        ...(explorationSeed.current && explorationSeed.current.length > 0
          ? { seedMessages: explorationSeed.current }
          : {}),
      });
      costBreaker.spend(staged.usage);
      // Verifier gave no verdict even after a retry: treat like a capacity cut (no coverage, no approve).
      if (staged.verdict.incomplete) unverifiedCandidateIds.add(candidate.id);
      verifyDone += 1;
      reportVerify();
      return staged;
    } finally {
      sem.release();
    }
  };

  // Dedup decisions are serialised through dedupChain so `survivors` stays consistent; verify stays concurrent.
  const survivors: DedupCandidate[] = [];
  let dedupChain: Promise<void> = Promise.resolve();
  const gate = (
    c: Candidate,
    isDuplicate: (cand: DedupCandidate, survivors: DedupCandidate[]) => boolean | Promise<boolean>,
  ): void => {
    const dc: DedupCandidate = { id: c.id, path: c.path, claim: c.claim };
    const decision = dedupChain.then(async (): Promise<boolean> => {
      try {
        if (await isDuplicate(dc, survivors)) {
          preVerifyDedupCount += 1;
          return false;
        }
      } catch {
        /* dedup failure: keep the candidate rather than lose coverage */
      }
      survivors.push(dc);
      return true;
    });
    dedupChain = decision.then(
      () => undefined,
      () => undefined,
    );
    stagedTasks.push(decision.then((keep) => (keep ? stageOne(c) : null)));
  };
  const priorReviewedPathSet = new Set((deps.priorReviewedPaths ?? []).map(normaliseReviewPath));

  const ledger = await runReviewPipeline({
    source: deps.source,
    isChangedLine: deps.isChangedLine,
    model: deps.model,
    ...(deps.fallbackModels ? { fallbackModels: deps.fallbackModels } : {}),
    streamFn: deps.streamFn,
    bundles: {
      mapper: deps.bundles.mapper,
      reviewer: deps.bundles.reviewer,
      synthesizer: deps.bundles.synthesizer,
    },
    budget: deps.budget,
    newId: deps.newId,
    ...(deps.changeSummary !== undefined ? { changeSummary: deps.changeSummary } : {}),
    ...(deps.knowledgeContext !== undefined ? { knowledgeContext: deps.knowledgeContext } : {}),
    ...(deps.repositoryGuidance !== undefined ? { repositoryGuidance: deps.repositoryGuidance } : {}),
    ...(deps.lfsPointerPaths !== undefined ? { lfsPointerPaths: deps.lfsPointerPaths } : {}),
    ...(deps.submoduleBumps !== undefined ? { submoduleBumps: deps.submoduleBumps } : {}),
    ...(deps.securityEvidence !== undefined ? { securityEvidence: deps.securityEvidence } : {}),
    ...(deps.memoryContext !== undefined ? { memoryContext: deps.memoryContext } : {}),
    ...(deps.ecosystemFacts !== undefined ? { ecosystemFacts: deps.ecosystemFacts } : {}),
    ...(deps.imageContext !== undefined ? { imageContext: deps.imageContext } : {}),
    ...(deps.memoryTools !== undefined ? { memoryTools: deps.memoryTools } : {}),
    ...(deps.knowledgeTools !== undefined ? { knowledgeTools: deps.knowledgeTools } : {}),
    ...(deps.pluginTools !== undefined ? { pluginTools: deps.pluginTools } : {}),
    ...(deps.commandTools !== undefined ? { commandTools: deps.commandTools } : {}),
    ...(deps.lookupSources !== undefined ? { lookupSources: deps.lookupSources } : {}),
    ...(deps.collectMemories !== undefined ? { collectMemories: deps.collectMemories } : {}),
    ...(deps.exploration !== undefined ? { exploration: deps.exploration } : {}),
    ...(deps.uncoveredPaths !== undefined ? { priorityPaths: deps.uncoveredPaths } : {}),
    ...(deps.plannedScopes !== undefined ? { plannedScopes: deps.plannedScopes } : {}),
    ...(deps.fileContext !== undefined ? { fileContext: deps.fileContext } : {}),
    ...(deps.filePatches !== undefined ? { filePatches: deps.filePatches } : {}),
    ...(deps.skills !== undefined ? { skills: deps.skills } : {}),
    ...(deps.priorReviewedPaths !== undefined
      ? { priorReviewedPaths: deps.priorReviewedPaths }
      : {}),
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    ...(deps.digForkFromMap ? { digForkFromMap: true } : {}),
    ...(deps.subagents ? { subagents: deps.subagents } : {}),
    ...(deps.language !== undefined ? { language: deps.language } : {}),
    ...(deps.digConcurrency !== undefined ? { digConcurrency: deps.digConcurrency } : {}),
    ...(deps.sessionReuse !== undefined ? { sessionReuse: deps.sessionReuse } : {}),
    // Incremental dedup streams candidates into verify as they appear. Batch dedup dedupes after the
    // pipeline (barrier below); session reuse needs the full exploration transcript, so no streaming.
    ...(incrementalIsDup && !deps.sessionReuse
      ? {
          onCandidates: (cands: Candidate[]) => {
            for (const c of cands)
              if (!priorReviewedPathSet.has(normaliseReviewPath(c.path))) gate(c, incrementalIsDup);
          },
        }
      : {}),
    ...(deps.isCancelled ? { isCancelled: checkCancelled } : {}),
    ...(deps.stageBudgetMs !== undefined ? { stageBudgetMs: deps.stageBudgetMs } : {}),
    ...(deps.stageClock ? { stageClock: deps.stageClock } : {}),
    ...(costCapUsd > 0 ? { costCapUsd } : {}),
    ...(costCapUsd > 0 ? { costBreaker } : {}),
    ...(deps.stageModel ? { stageModel: deps.stageModel } : {}),
  });
  const explorationEndedAt = Date.now();
  if (ledger.explorationTranscript) explorationSeed.current = ledger.explorationTranscript;

  // Check cancellation before the completeness gate: unfinished scopes from a cancel are not a model
  // failure, and a retry would re-run the superseded head.
  if (ledger.cancelled === true) cancelled = true;

  /*
   * Completeness gate against "model/gateway failure -> 0 scopes -> silent approve".
   * With candidates in hand, continue to verify and publish, report the coverage gap, and do not
   * approve. With no candidate at all, "clean" and "failed" are indistinguishable, so throw a
   * retryable error. A truly clean PR (map complete, 0 reviewable scopes) does not enter this branch;
   * an empty map plan with reviewable files gets fallback scopes (remainder.ts).
   */
  const explorationFailed =
    ledger.mapStatus !== 'complete' ||
    (ledger.coverage.scopesTotal > 0 && ledger.coverage.scopesComplete === 0);
  if (!cancelled && explorationFailed && ledger.candidates.length === 0) {
    // When map was skipped (small change), failure is in dig: use the failed scope's kind for the retry tier.
    const failedScope = ledger.scopeOutcomes.find((o) => o.status !== 'complete' && o.failureKind !== undefined);
    const fk = ledger.mapFailureKind ?? (ledger.mapStatus === 'complete' ? failedScope?.failureKind : undefined);
    const failureDetail = ledger.mapErrorMessage ?? (ledger.mapStatus === 'complete' ? failedScope?.incompleteReason : undefined);
    const cut = ledger.deadlineCutStages ?? [];
    const reason =
      cut.length > 0
        ? `阶段墙钟到点(${cut.join('/')})且一个 candidate 都没产出(提该段墙钟或换模型档)`
        : fk === 'content_filter'
          ? '模型护栏拒绝(content_filter,重试无用,建议换 prompt/模型档)'
          : fk === 'context_overflow'
            ? '上下文超限(context_overflow,重试无用;换大窗口模型档或缩小 PR)'
          : fk === 'model_unavailable' ? '模型暂无可用额度(模型表里有备选模型才能自动换)'
          : fk === 'gateway_transport'
            ? '网关/传输故障(SSE 中断/5xx/网络,可重试)'
            : fk === 'timeout'
              ? '网关/模型超时(可重试)'
              : ledger.mapIncompleteReason === 'no finalization tool called'
                ? '模型没调收尾工具就停了(不是网关故障;这个模型多半跟不上工具协议,换模型档)'
                : ledger.mapIncompleteReason === 'turn budget exhausted'
                  ? '轮次预算用尽(模型绕圈子没收敛;提预算或换模型档)'
                  : '疑模型/网关故障,重试而非误 approve';
    // incompleteReason and the raw error distinguish "model never called the finalization tool" from
    // "gateway dropped" in logs.
    throw new ReviewIncompleteError(
      `review exploration incomplete: mapStatus=${ledger.mapStatus}, scopes=${ledger.coverage.scopesComplete}/${ledger.coverage.scopesTotal}, failureKind=${fk ?? 'n/a'}, reason=${ledger.mapIncompleteReason ?? 'n/a'}, scopeReasons=${[...new Set(ledger.scopeOutcomes.filter((o) => o.status !== 'complete').map((o) => o.incompleteReason ?? o.status))].join('; ') || 'n/a'} — ${reason}`,
      {
        ...(fk !== undefined ? { failureKind: fk } : {}),
        ...(failureDetail !== undefined ? { failureDetail } : {}),
        ...(cut.length > 0 ? { deadlineCut: true } : {}),
      },
    );
  }

  if (batchDedupe) {
    const eligible = ledger.candidates.filter(
      (candidate) => !priorReviewedPathSet.has(normaliseReviewPath(candidate.path)),
    );
    const suppressed = await batchDedupe(
      eligible.map((c) => ({ id: c.id, path: c.path, claim: c.claim })),
    );
    preVerifyDedupCount = suppressed.size;
    for (const c of ledger.candidates) {
      stagedTasks.push(
        priorReviewedPathSet.has(normaliseReviewPath(c.path)) || suppressed.has(c.id)
          ? Promise.resolve<Staged | null>(null)
          : stageOne(c),
      );
    }
  } else if (deps.sessionReuse && incrementalIsDup) {
    // Streaming was disabled for session reuse; gate all candidates now.
    for (const c of ledger.candidates)
      if (!priorReviewedPathSet.has(normaliseReviewPath(c.path))) gate(c, incrementalIsDup);
  }
  void preVerifyDedupCount;

  // Restore canonical order (ledger.candidates); dig completion order differs. Dedup-skipped entries are null.
  const stagedById = new Map(
    (await Promise.all(stagedTasks))
      .filter((s): s is Staged => s !== null)
      .map((s) => [s.candidate.id, s]),
  );
  const staged: Staged[] = ledger.candidates
    .map((c) => stagedById.get(c.id))
    .filter((s): s is Staged => s !== undefined);

  // In-flight verifies may have observed a cancel while awaited above.
  if (await checkCancelled()) cancelled = true;

  return {
    staged,
    ledger,
    verifyTailMs: Date.now() - explorationEndedAt,
    ...(unverifiedCandidateIds.size > 0
      ? { unverifiedCandidateIds: [...unverifiedCandidateIds] }
      : {}),
    ...(costCappedCandidates > 0 ? { costCappedCandidates } : {}),
    ...(deadlineCappedCandidates > 0 ? { deadlineCappedCandidates } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  };
}

/**
 * Cancelled outcome: nothing published, usage still returned for billing. No findings and no
 * coveredFiles/reviewContractDigest: the run was incomplete, and recording coverage would make the
 * next round skip files that never got results.
 */
function cancelledOutcome(produced: ProducedReview): ReviewOutcome {
  const usage = sumUsage([produced.ledger.usage, ...produced.staged.map((s) => s.usage)]);
  const cancelledVerify = sumUsage(produced.staged.map((s) => s.usage));
  const cancelledStageUsage = {
    ...(produced.ledger.stageUsage ?? {}),
    ...(cancelledVerify ? { verify: cancelledVerify } : {}),
  };
  const covered = coveredPathsOf(produced.ledger, unverifiedIdsOf(produced));
  return {
    candidateCount: produced.ledger.candidates.length,
    findings: [],
    coverage: produced.ledger.coverage,
    ...(covered.length > 0 ? { coveredPaths: covered } : {}),
    publishedInline: 0,
    cancelled: true,
    ...(usage ? { usage } : {}),
    ...(Object.keys(cancelledStageUsage).length > 0 ? { stageUsage: cancelledStageUsage } : {}),
  };
}

/**
 * Control-plane publish of a produced review: profile handling -> noise budget -> incremental
 * reconciliation -> idempotent publish. Prior-blocking reconciliation (an LLM call) also runs here.
 */
export async function publishReview(
  produced: ProducedReview,
  deps: ReviewOrchestratorDeps,
): Promise<ReviewOutcome> {
  const startedAt = Date.now();
  const outcome = await publishProduced(produced, deps);
  const stageMs: Record<string, number> = {
    ...(produced.ledger.stageMs ?? {}),
    ...(produced.verifyTailMs !== undefined ? { verifyTail: produced.verifyTailMs } : {}),
    publish: Date.now() - startedAt,
  };
  return { ...outcome, stageMs };
}

async function publishProduced(
  produced: ProducedReview,
  deps: ReviewOrchestratorDeps,
): Promise<ReviewOutcome> {
  const { staged, ledger } = produced;
  try {
    deps.onProgress?.({ stage: 'publish' });
  } catch {
    /* best effort */
  }
  // The publisher's HEAD recheck would also reject, but only after all the work below; this also
  // covers a cancel arriving between sandbox produce and publish.
  if (produced.cancelled === true || (await deps.isCancelled?.()) === true) {
    return cancelledOutcome(produced);
  }
  const simFn = deps.claimSimilarity ?? claimSimilarity;
  // correctness/security are never suppressed by the profile.
  const slopEnabled = deps.profile ? deps.profile.nonBugCategoriesEnabled : true;
  // Near-duplicates of the same root cause: keep the highest rank, suppress the rest.
  const dupIds = nearDuplicateIds(
    staged.map((s) => ({
      id: s.candidate.id,
      path: s.candidate.path,
      claim: s.candidate.claim,
      rank: s.rank,
      ...(s.anchor ? { line: s.anchor.line } : {}),
    })),
    NEAR_DUP_THRESHOLD,
    simFn,
  );
  const dispositions = new Map(
    staged.map((s): [string, { reason?: SuppressReason; slop: boolean; forceSummary: boolean }] => {
      const isDup = dupIds.has(s.candidate.id);
      if (isSlopKind(s.candidate.category)) {
        const disp = slopDisposition(slopEnabled);
        const reason: SuppressReason | undefined = isDup ? 'duplicate' : disp.suppressed ? 'slop' : undefined;
        return [s.candidate.id, { ...(reason ? { reason } : {}), slop: true, forceSummary: disp.collapsed }];
      }
      const reason: SuppressReason | undefined = isDup
        ? 'duplicate'
        : deps.profile &&
            suppressedByThreshold(coerceCategory(s.candidate.category), s.verdict.severity, deps.profile)
          ? 'below-threshold'
          : undefined;
      return [s.candidate.id, { ...(reason ? { reason } : {}), slop: false, forceSummary: false }];
    }),
  );

  // Findings anchored in path-filtered files are dropped entirely (not inline, summary or persisted).
  const ignoredPathSet = new Set((deps.ignoredFiles ?? []).map((f) => f.path));
  const publishable =
    ignoredPathSet.size > 0 ? staged.filter((s) => !ignoredPathSet.has(s.candidate.path)) : staged;

  /*
   * Per-finding facts (fingerprints, dismissal, quota-independent suppression), computed before
   * quotas because gate reconciliation needs them and must run before quota allocation (it can yield
   * new issues that compete for inline slots). One table so the gate and presentation agree.
   */
  const derived = new Map(
    publishable.map((s) => {
      const category = coerceCategory(s.candidate.category);
      const fingerprint = deps.computeFingerprint?.({
        category,
        claim: s.candidate.claim,
        primaryAnchorText: s.candidate.primaryAnchorText,
        path: s.candidate.path,
      });
      const weakFingerprint = deps.computeWeakFingerprint?.({
        category,
        primaryAnchorText: s.candidate.primaryAnchorText,
        path: s.candidate.path,
      });
      const dismissed = isDismissed(
        deps.dismissedFindings,
        {
          path: s.candidate.path,
          category,
          claim: s.candidate.claim,
          fingerprint,
          weakFingerprint,
        },
        simFn,
      );
      /*
       * Quota-independent suppression. The quota rule (`summary_overflow=false`) only affects
       * non-blocking items, so this is exact for the blocking-reproduction check below.
       */
      const baseReason: SuppressReason | undefined =
        dispositions.get(s.candidate.id)!.reason ??
        (!shouldPublish(s.decision.status)
          ? 'not-confirmed'
          : deps.reportPreexistingUnrelated === 'off' && s.verdict.changeRelation === 'preexisting-unrelated'
            ? 'unrelated'
            : dismissed
              ? 'dismissed'
              : undefined);
      return [
        s.candidate.id,
        { category, fingerprint, dismissed, baseSuppressed: baseReason !== undefined, ...(baseReason ? { baseReason } : {}) },
      ] as const;
    }),
  );

  /*
   * Cross-round identity matching, done once for the whole batch (it calls the model and the loop
   * below is synchronous). Empty without a matcher or prior findings; then strong fingerprints apply.
   */
  let priorMatchTruncated = 0;
  const priorMatches =
    deps.findingMatcher && deps.priorFindings && deps.priorFindings.length > 0
      ? await deps.findingMatcher(
          publishable.map((s) => {
            const cat = coerceCategory(s.candidate.category);
            const fp = deps.computeFingerprint?.({
              category: cat,
              claim: s.candidate.claim,
              primaryAnchorText: s.candidate.primaryAnchorText,
              path: s.candidate.path,
            });
            return {
              id: s.candidate.id,
              category: cat,
              claim: s.candidate.claim,
              path: s.candidate.path,
              codeWindow: s.candidate.primaryAnchorText,
              ...(fp !== undefined ? { fingerprint: fp } : {}),
            };
          }),
          deps.priorFindings,
          {
            onTruncate: (dropped) => {
              priorMatchTruncated += dropped;
            },
          },
        )
      : new Map();

  /*
   * Prior blocking gate: approve only when every prior blocking finding is confirmed fixed. Ones
   * reproduced this round are judged by this round; the rest are reconciled (file-changed prefilter
   * + targeted LLM) instead of relying on random rediscovery. Runs before quota allocation so new
   * issues found during reconciliation compete for inline slots.
   */
  const thisRunFingerprints = new Set(
    [
      ...[...derived.values()].map((d) => d.fingerprint),
      // Deterministic CVE findings, merged below, also count as reported this round.
      ...(deps.dependencyFindings ?? []).map((d) =>
        deps.computeFingerprint?.({
          category: 'security',
          claim: d.claim,
          primaryAnchorText: d.advisoryId,
        }),
      ),
    ].filter((fp): fp is string => fp !== undefined),
  );
  /*
   * Cross-round matches also count as reproduced, otherwise a drifted fingerprint blocks twice.
   * Only matches that are still blocking count: a match demoted or suppressed would leave the prior
   * item neither reconciled nor counted, i.e. a silent approve.
   * Exception: when attribution changed to a non-blocking change relation, policy says it does not
   * block, so it exits reconciliation (even if suppressed) instead of re-entering as still-present.
   */
  const blockScope = {
    ...(deps.blockPreexisting !== undefined ? { blockPreexisting: deps.blockPreexisting } : {}),
  };
  const reproducedPriorIds = new Set(
    publishable
      .filter((s) => {
        if (!priorMatches.get(s.candidate.id)) return false;
        if (!changeRelationCanBlockMerge(s.verdict.changeRelation, blockScope)) return true;
        return s.decision.blocking && !derived.get(s.candidate.id)!.baseSuppressed;
      })
      .map((s) => priorMatches.get(s.candidate.id)!.priorFindingId),
  );
  const priorToReconcile = (deps.priorBlockingFindings ?? []).filter(
    (p) => !thisRunFingerprints.has(p.fingerprint) && !reproducedPriorIds.has(p.findingId),
  );
  const resolutionDeps = {
    source: deps.source,
    model: deps.model,
    ...(deps.fallbackModels ? { fallbackModels: deps.fallbackModels } : {}),
    streamFn: deps.streamFn,
    budget: deps.budget,
    ...(deps.filesChangedSince ? { filesChangedSince: deps.filesChangedSince } : {}),
    ...(deps.resolutionMaxVerify !== undefined ? { maxVerify: deps.resolutionMaxVerify } : {}),
  };
  const resolution: ResolutionResult[] =
    priorToReconcile.length > 0 ? await reconcilePriorBlocking(resolutionDeps, priorToReconcile) : [];

  /*
   * Non-blocking prior findings on re-reviewed files that were not reported again: checked only to
   * decide whether they stay active. New issues from this check are ignored (the file was just explored).
   */
  const openToReconcile = (deps.openPriorFindings ?? []).filter(
    (p) =>
      !thisRunFingerprints.has(p.fingerprint) &&
      ![...priorMatches.values()].some((m) => m.priorFindingId === p.findingId),
  );
  const openResolution: ResolutionResult[] =
    openToReconcile.length > 0
      ? await reconcilePriorBlocking(
          resolutionDeps,
          openToReconcile.map((p) => ({
            findingId: p.findingId,
            fingerprint: p.fingerprint,
            claim: p.claim,
            path: p.path,
            ...(p.anchorText !== undefined ? { anchorText: p.anchorText } : {}),
            ...(p.lastSeenHeadSha !== undefined ? { lastSeenHeadSha: p.lastSeenHeadSha } : {}),
          })),
        )
      : [];
  const openStillPresentIds = new Set(
    openResolution.filter((r) => r.status === 'still-present').map((r) => r.findingId),
  );
  const openStillPresent = openToReconcile.filter((p) => openStillPresentIds.has(p.findingId));

  /*
   * New issues found by reconciliation (old defect fixed, another one nearby) go through the same
   * verify -> anchor -> matrix -> quota path as this round's candidates instead of inheriting the old
   * finding's identity. Run concurrently.
   */
  const rediscovered = (
    await Promise.all(
      resolution
        .filter((r) => r.newIssue)
        .map(async (r) => {
          const n = r.newIssue!;
          try {
            return await stageCandidate(
              deps,
              {
                id: deps.newId(),
                // Not produced by a scope's exploration.
                source: 'synthesis',
                claim: n.claim,
                category: n.category,
                suspectedSeverity: n.suspectedSeverity,
                path: n.path,
                primaryAnchorText: n.anchorText,
                changeRelationHypothesis: 'introduced',
              },
            );
          } catch {
            return null; // one failed verify must not fail the whole publish
          }
        }),
    )
  ).filter((x): x is Staged => x !== null);
  for (const r of rediscovered) {
    dispositions.set(r.candidate.id, { slop: false, forceSummary: false });
    const category = coerceCategory(r.candidate.category);
    const fingerprint = deps.computeFingerprint?.({
      category,
      claim: r.candidate.claim,
      primaryAnchorText: r.candidate.primaryAnchorText,
      path: r.candidate.path,
    });
    derived.set(r.candidate.id, {
      category,
      fingerprint,
      dismissed: false,
      baseSuppressed: !shouldPublish(r.decision.status),
      ...(!shouldPublish(r.decision.status) ? { baseReason: 'not-confirmed' as const } : {}),
    });
  }
  /*
   * Everything published this round, sorted by rank descending: this is the inline comment posting
   * order (and the PR conversation order), matching the order applyNoiseBudget grants slots.
   */
  const publishing = (
    rediscovered.length > 0 ? [...publishable, ...rediscovered] : publishable
  ).sort((a, b) => b.rank - a.rank);

  // Nits are inline candidates too (only useful on the line) but use a separate quota
  // (NoiseBudget.maxInlineNits) so they do not compete with defects.
  const inlineItems = publishing
    .filter((s) => {
      const d = dispositions.get(s.candidate.id)!;
      return !d.reason && !d.forceSummary && s.decision.placement === 'inline' && s.anchor;
    })
    .map((s) => ({
      id: s.candidate.id,
      kind: s.decision.kind,
      file: s.candidate.path,
      rank: s.rank,
    }));
  const budgeted = applyNoiseBudget(inlineItems, deps.noiseBudget);
  const budgetResult = new Map(budgeted.map((b) => [b.id, b]));

  const findings: ProcessedFinding[] = [];
  const suggestionRejected: string[] = [];
  let suggestionsPublished = 0;
  // Inline comments are merged into one PR review instead of one review per finding.
  const inlineComments: { findingId: string; anchor: ProviderAnchor; bodyMarkdown: string }[] = [];
  // "Actionable comments posted" excludes nits.
  let nitInlineCount = 0;

  for (const s of publishing) {
    const d = dispositions.get(s.candidate.id)!;
    const { category, fingerprint, baseSuppressed, baseReason } = derived.get(s.candidate.id)!;
    // Cross-round match wins (it recognises rewording and moves); otherwise strong fingerprint equality.
    const priorMatch = priorMatches.get(s.candidate.id);
    const incremental: 'new' | 'persisted' | undefined = priorMatch
      ? 'persisted'
      : fingerprint !== undefined && deps.priorFingerprints
        ? deps.priorFingerprints.has(fingerprint)
          ? 'persisted'
          : 'new'
        : undefined;

    /*
     * Demotion chain (slop/persisted/budget/anchor), shared by nits and defects. It only changes
     * placement; status (confirmed/uncertain/refuted) and kind (defect/nit) are fixed by the matrix.
     */
    const nit = s.decision.kind === 'nit';
    const confirmed = s.decision.status === 'confirmed';
    let placement: PublicationPlacement = s.decision.placement;
    // `demote` records a reason only when it actually moves an item off inline; the matrix's own
    // demotion (low severity / weak anchor) heads the chain.
    const demotions: DemotionReason[] = s.decision.demotion ? [s.decision.demotion] : [];
    const demote = (reason: DemotionReason): void => {
      if (placement !== 'inline') return;
      placement = 'folded';
      demotions.push(reason);
    };
    if (d.forceSummary && confirmed) demote('slop-folded');
    if (incremental === 'persisted') demote('previously-reported');
    const budget = budgetResult.get(s.candidate.id);
    if (budget?.overflow) demote(budget.overflowReason ?? 'inline-budget');
    // The matrix and meetsInlineThreshold currently agree, but if either loosens, an "inline" finding
    // without an anchor would be neither posted nor folded.
    if (!s.anchor) demote('no-anchor');
    // GitHub rejects the whole review (422 "Line could not be resolved") if any comment is outside the
    // diff, and an exact anchor match can land on identical text outside the changed hunk.
    if (
      s.anchor &&
      !(s.anchor.side === 'head' && deps.isChangedLine(s.candidate.path, s.anchor.line))
    ) {
      demote('anchor-outside-diff');
    }

    /*
     * Must follow the demotion chain: `summary_overflow=false` drops items demoted for quota.
     * Quota-independent reasons are in `baseSuppressed`, computed earlier for gate reconciliation.
     */
    const suppressed =
      baseSuppressed ||
      // Only quota demotions are dropped. Blocking items are never dropped: a display setting must
      // not remove them from blockingCount and open the gate.
      (deps.summaryOverflow === false &&
        !s.decision.blocking &&
        demotions.some((r) => r === 'inline-budget' || r === 'per-file-budget'));

    const base: ProcessedFinding = {
      candidateId: s.candidate.id,
      claim: s.candidate.claim,
      path: s.candidate.path,
      pathExists: s.pathExists,
      category,
      primaryAnchorText: s.candidate.primaryAnchorText,
      placement,
      decision: s.decision,
      verdict: s.verdict,
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      ...(incremental !== undefined ? { incremental } : {}),
      // Persistence reuses the matched row; otherwise a drifted fingerprint inserts a duplicate.
      ...(priorMatch
        ? { matchedFindingId: priorMatch.priorFindingId, matchMethod: priorMatch.method }
        : {}),
      ...(s.anchor ? { anchor: s.anchor } : {}),
      ...(s.refuterUpheld !== undefined ? { refuterUpheld: s.refuterUpheld } : {}),
      ...(d.slop ? { slop: true } : {}),
      ...(suppressed ? { suppressed: true, suppressReason: baseReason ?? 'quota' } : {}),
      ...(demotions.length > 0 ? { demotions } : {}),
    };

    if (!suppressed && placement === 'inline' && s.anchor && confirmed) {
      // A committable suggestion is a one-click code change, so it is validated verbatim first. On
      // success the anchor expands to the suggestion's range: GitHub replaces exactly the commented lines.
      let suggestionText: string | undefined;
      let anchor = s.anchor;
      if (deps.suggestionsEnabled !== false && s.verdict.suggestion) {
        const headLines = await deps.readHeadLines(s.candidate.path);
        const checked = validateSuggestion(s.verdict.suggestion, s.verdict.decision === 'accept', {
          headLines,
          isChangedLine: (line) => deps.isChangedLine(s.candidate.path, line),
          anchorLine: s.anchor.line,
          ...(deps.suggestionMaxLines !== undefined ? { maxLines: deps.suggestionMaxLines } : {}),
        });
        if (checked.ok) {
          suggestionText = checked.suggestion.replacement;
          base.suggestion = {
            startLine: checked.suggestion.startLine,
            endLine: checked.suggestion.endLine,
            replacement: checked.suggestion.replacement,
          };
          suggestionsPublished += 1;
          anchor =
            checked.suggestion.startLine === checked.suggestion.endLine
              ? { ...s.anchor, line: checked.suggestion.endLine }
              : {
                  ...s.anchor,
                  line: checked.suggestion.endLine,
                  startLine: checked.suggestion.startLine,
                  startSide: s.anchor.side,
                };
        } else {
          suggestionRejected.push(checked.reason);
        }
      }
      const bodyMarkdown = renderFindingComment(
        {
          category,
          ...(nit ? { nit: true } : {}),
          severity: s.verdict.severity,
          ...(s.verdict.effort ? { effort: s.verdict.effort } : {}),
          claim: s.candidate.claim,
          changeRelation: s.verdict.changeRelation,
          confirmation: s.verdict.confirmation,
          reachable: s.verdict.reachable,
          residualUncertainty: s.verdict.residualUncertainty,
          path: s.candidate.path,
          ...(suggestionText !== undefined ? { suggestion: suggestionText } : {}),
        },
        deps.language,
      );
      inlineComments.push({ findingId: s.candidate.id, anchor, bodyMarkdown });
      if (nit) nitInlineCount += 1;
    }
    if (s.anchor) {
      const context = codeContext(await deps.readHeadLines(s.candidate.path), base.suggestion?.startLine ?? s.anchor.line, base.suggestion?.endLine ?? s.anchor.line);
      if (context) base.codeContext = context;
    }
    findings.push(base);
  }

  // Publishing modes, in order of preference:
  //   1. summary -> PR description; inline comments -> one batch review;
  //   2. no description support -> one batch review whose body holds the summary;
  //   3. neither -> individual inline comments + a separate summary comment.
  let publishedInline = 0;
  let publishedSummary = false;
  // Results posted as a review/comment (the PR description does not count).
  let resultsPosted = false;
  const target = deps.publishTarget;
  // Deterministic CVE findings: folded in the summary, never anchored inline.
  for (const d of deps.dependencyFindings ?? []) {
    const candidateId = deps.newId();
    const fingerprint = deps.computeFingerprint?.({
      category: 'security',
      claim: d.claim,
      primaryAnchorText: d.advisoryId,
    });
    const weakDepFp = deps.computeWeakFingerprint?.({
      category: 'security',
      primaryAnchorText: d.advisoryId,
    });
    const unrelatedOff = !d.introduced && deps.reportPreexistingUnrelated === 'off';
    const suppressedDep =
      unrelatedOff ||
      isDismissed(
        deps.dismissedFindings,
        {
          path: d.path,
          category: 'security',
          claim: d.claim,
          fingerprint,
          weakFingerprint: weakDepFp,
        },
        simFn,
      );
    const incremental: 'new' | 'persisted' | undefined =
      fingerprint !== undefined && deps.priorFingerprints
        ? deps.priorFingerprints.has(fingerprint)
          ? 'persisted'
          : 'new'
        : undefined;
    findings.push({
      candidateId,
      claim: d.claim,
      path: d.path,
      pathExists: true, // manifest path from the scanner, not the model
      category: 'security',
      primaryAnchorText: d.advisoryId,
      placement: 'folded',
      // Bypasses the matrix: scanner output is deterministic, so it is confirmed outright.
      decision: {
        status: 'confirmed',
        kind: 'defect',
        placement: 'folded',
        blocking: d.blocking && !suppressedDep,
        reason: 'dependency-evidence',
        demotion: 'dependency-evidence',
      },
      demotions: ['dependency-evidence'],
      verdict: {
        candidateId,
        decision: 'accept',
        introducedByChange: d.introduced,
        reachable: true,
        actionable: true,
        changeRelation: d.introduced ? 'introduced' : 'preexisting-unrelated',
        severity: d.severity,
        confirmation: 'tool-confirmed',
        residualUncertainty: [],
        incomplete: false,
      },
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      ...(incremental !== undefined ? { incremental } : {}),
      ...(suppressedDep ? { suppressed: true, suppressReason: unrelatedOff ? 'unrelated' : 'dismissed' } : {}),
    });
  }

  /*
   * Summary sections and the agent prompt render in this order, so sort by severity descending.
   * Only the view is sorted; `findings` order is left to persistence. The sort is stable, so rank
   * order holds within a severity.
   */
  const visible = findings
    .filter((f) => !f.suppressed)
    .sort((a, b) => severityRank(b.verdict.severity) - severityRank(a.verdict.severity));
  const newVisible = visible.filter((f) => f.incremental !== 'persisted');
  const persistedVisible = visible.filter((f) => f.incremental === 'persisted');
  /*
   * Stale archival: requires both "not reported for several rounds" and "file changed since"; absence
   * alone proves nothing since exploration is random. This is the only path where a finding silently
   * leaves, so every check errs conservative: unknown -> keep; reported again -> keep; still blocking -> keep.
   */
  const stillBlockingPriorIds = new Set((deps.priorBlockingFindings ?? []).map((p) => p.findingId));
  const matchedPriorIds = new Set([...priorMatches.values()].map((m) => m.priorFindingId));
  // Cache per sha: candidates can number in the hundreds but share few base shas (one git call each).
  const staleChangedSince = new Map<string, Promise<ReadonlySet<string> | null>>();
  const staleFindingIds: string[] = [];
  for (const c of deps.staleCandidates ?? []) {
    if (!c.path || !c.lastSeenHeadSha || !deps.filesChangedSince) continue;
    if (stillBlockingPriorIds.has(c.findingId)) continue;
    if (matchedPriorIds.has(c.findingId) || thisRunFingerprints.has(c.fingerprint)) continue;
    let pending = staleChangedSince.get(c.lastSeenHeadSha);
    if (!pending) {
      pending = deps.filesChangedSince(c.lastSeenHeadSha).catch(() => null);
      staleChangedSince.set(c.lastSeenHeadSha, pending);
    }
    const changed = await pending;
    if (changed === null || !changed.has(c.path)) continue;
    staleFindingIds.push(c.findingId);
  }

  // Skip carried findings already reported this round, still blocking (gate section), or dismissed.
  const carried = (deps.carriedFindings ?? []).filter(
    (c) =>
      !matchedPriorIds.has(c.findingId) &&
      !thisRunFingerprints.has(c.fingerprint) &&
      !stillBlockingPriorIds.has(c.findingId) &&
      !isDismissed(
        deps.dismissedFindings,
        { path: c.path, category: c.category, claim: c.claim, fingerprint: c.fingerprint, weakFingerprint: undefined },
        simFn,
      ),
  );

  const unresolvedPriorBlocking = resolution.filter((r) => r.status === 'still-present');
  // Display-only merge of rows for the same defect; blockingCount still uses the unmerged list.
  const unresolvedForDisplay = mergeSameDefect(unresolvedPriorBlocking, NEAR_DUP_THRESHOLD, simFn);
  const resolvedFingerprints = [...resolution, ...openResolution]
    .filter((r) => r.status === 'resolved')
    .map((r) => r.fingerprint);
  const resolvedFindingIds = [...resolution, ...openResolution]
    .filter((r) => r.status === 'resolved')
    .map((r) => r.findingId);

  /*
   * Was the run complete? Unfinished scopes, unverified candidates and cost-cut work all mean part of
   * the change was not reviewed, and approve endorses the whole change. Gaps never relax blocking;
   * they only withhold approve. With a ledger this is PR-level (a round can finish 3/3 while half the
   * PR is unreviewed); without one, single-round.
   */
  const unverifiedLeftovers = (produced.costCappedCandidates ?? 0) + (produced.deadlineCappedCandidates ?? 0)
    + produced.staged.filter((s) => s.verdict.incomplete).length;
  const coveredPaths = coveredPathsOf(ledger, unverifiedIdsOf(produced));
  const plannedPaths = plannedPathsOf(ledger);
  // Without any map `files` (optional field) "nothing covered" means unknown; fall back to single-round.
  const ledgerUsable = deps.uncoveredPaths !== undefined && plannedPaths.length > 0;
  const remaining = ledgerUsable
    ? deps.uncoveredPaths!.map(normaliseReviewPath).filter((path) => !coveredPaths.includes(path))
    : undefined;
  const deferred = new Set((deps.deferredPaths ?? []).map(normaliseReviewPath));
  const unreachedPaths = remaining?.filter((p) => plannedPaths.includes(p));
  const outcomeByScope = new Map(ledger.scopeOutcomes.map((o) => [o.scopeId, o]));
  const incompleteScopes = ledger.scopes.flatMap((scope) => {
    const o = outcomeByScope.get(scope.id);
    if (o?.status === 'complete') return [];
    return [{ title: scope.title, status: o?.status ?? 'not run', ...(o?.incompleteReason ? { reason: o.incompleteReason } : {}) }];
  });
  const deferredPaths = remaining?.filter((p) => !plannedPaths.includes(p) && deferred.has(p));
  const unplannedPaths = remaining?.filter((p) => !plannedPaths.includes(p) && !deferred.has(p));
  const coverageShort =
    unreachedPaths !== undefined
      ? unreachedPaths.length > 0 || (unplannedPaths?.length ?? 0) > 0 || (deferredPaths?.length ?? 0) > 0
      : ledger.coverage.scopesTotal > 0 &&
        ledger.coverage.scopesComplete < ledger.coverage.scopesTotal;
  const synthesisIncomplete =
    (ledger.synthesisStatus !== undefined && ledger.synthesisStatus !== 'complete') ||
    ledger.deadlineCutStages?.includes('synthesis') === true;
  const partialRun =
    coverageShort ||
    // Deferred files always block approve, even when the ledger is unusable.
    deferred.size > 0 ||
    unverifiedLeftovers > 0 ||
    synthesisIncomplete ||
    (ledger.costCappedScopes ?? 0) > 0;

  /*
   * Review event:
   *   - any blocking (this round + unfixed prior) -> request-changes;
   *   - incomplete run / auto_approve off -> comment (cannot endorse what was not reviewed);
   *   - new confirmed non-blocking findings this round -> comment;
   *   - otherwise approve; previously reported non-blocking findings and non-blocking dependency
   *     advisories (listed in the summary only) do not block approve.
   * `merge_gate.enabled` only controls whether the check run fails.
   */
  if ((await deps.isCancelled?.()) === true) return cancelledOutcome(produced);

  const blockingCount =
    visible.filter((f) => f.decision.blocking).length + unresolvedPriorBlocking.length;
  const newNonBlockingNotes = newVisible.some(
    (f) => isConfirmed(f) && f.decision.reason !== 'dependency-evidence',
  );
  const event: 'comment' | 'approve' | 'request-changes' =
    blockingCount > 0
      ? 'request-changes'
      : deps.autoApprove === false || partialRun || newNonBlockingNotes
        ? 'comment'
        : 'approve';
  recordReview(event);
  const usage = sumUsage([ledger.usage, ...staged.map((s) => s.usage)]);
  {
    // With description support the walkthrough goes into the PR description, so omit changeIntent here.
    const hasDescription = deps.updateSummaryDescription !== undefined;
    const summaryBody = renderReviewSummary(
      {
        changeIntent: hasDescription ? '(unspecified)' : (deps.changeSummary ?? '(unspecified)'),
        // Inline comments actually posted, excluding nits (not blocking count).
        actionableCount: inlineComments.length - nitInlineCount,
        confirmedFindings: newVisible
          .filter((f) => f.placement === 'inline' && !isNit(f))
          .map((f) => ({ severity: f.verdict.severity, claim: f.claim, location: 'inline' })),
        validation: [],
        // Derived from the event actually sent, so the text never says "approving" on a comment.
        approving: event === 'approve',
        blockingCount,
        /*
         * Same precedence as `event`. Not inferred from `actionableCount`: a blocking item anchored
         * outside the diff has no inline comment, so that count can be 0.
         */
        ...(event === 'approve'
          ? {}
          : {
              notApprovingReason: (blockingCount > 0
                ? 'blocking'
                : partialRun
                  ? 'incomplete'
                  : deps.autoApprove === false
                    ? 'auto-approve-off'
                    : 'non-blocking') as 'blocking' | 'incomplete' | 'auto-approve-off' | 'non-blocking',
            }),
        // Numbers only: gap causes use pipeline-internal terms and stay out of the PR (check run,
        // console and logs show them).
        coverage: sectionCoverage(ledger),
        // All nits; `inline` when posted on the line, `summary` when only here.
        nitpickFindings: newVisible.filter(isNit).map((f) => ({
          severity: f.verdict.severity,
          claim: f.claim,
          location: f.placement === 'inline' ? 'inline' : 'summary',
        })),
        // Confirmed folded findings split by changeRelation; unconfirmed ones have their own sections
        // below without severity badges.
        additionalFindings: newVisible
          .filter(
            (f) =>
              isConfirmed(f) &&
              f.placement === 'folded' &&
              !isNit(f) &&
              f.verdict.changeRelation !== 'preexisting-unrelated',
          )
          .map(summaryEntry),
        preexistingFindings: newVisible
          .filter(
            (f) =>
              isConfirmed(f) &&
              f.placement === 'folded' &&
              !isNit(f) &&
              f.verdict.changeRelation === 'preexisting-unrelated',
          )
          .map(summaryEntry),
        previouslyReported: [
          ...persistedVisible.filter((f) => isConfirmed(f) && f.placement === 'folded').map(summaryEntry),
          ...[...carried, ...openStillPresent].map((c) => ({
            severity: c.severity,
            ...(c.effort ? { effort: c.effort } : {}),
            claim: c.claim,
            path: c.path,
            demotions: ['previously-reported'],
          })),
        ],
        // Unconfirmed: high-impact -> unverified risks, the rest -> low evidence; new and persisted together.
        unverifiedRisks:
          deps.showUnverifiedRisks === false
            ? []
            : visible
                .filter((f) => !isConfirmed(f) && unconfirmedSection(f) === 'unverified-risks')
                .map(unconfirmedLine),
        lowEvidence: visible
          .filter((f) => !isConfirmed(f) && unconfirmedSection(f) === 'low-evidence')
          .map(unconfirmedLine),
        // Include the reconciliation reason so authors can see why the gate thinks it is unfixed.
        unresolvedFromPrevious: unresolvedForDisplay.kept.map((r) => {
          const head = r.path ? `${r.path}: ${r.claim}` : r.claim;
          return r.reason ? `${head} — ${r.reason}` : head;
        }),
        suppressed:
          deps.showSuppressedDetails === true
            ? findings.filter((f) => f.suppressed).map((f) => f.claim)
            : [],
        ...(deps.stack ? { stack: deps.stack } : {}),
        ...(deps.runConfig ? { runConfig: deps.runConfig } : {}),
        ...(deps.commitRange ? { commits: deps.commitRange } : {}),
        ...(deps.selectedPaths && deps.selectedPaths.length > 0 ? { selectedFiles: [...deps.selectedPaths] } : {}),
        ...(deps.priorReviewedPaths && deps.priorReviewedPaths.length > 0
          ? { alreadyReviewedFiles: [...deps.priorReviewedPaths] }
          : {}),
        ...(deps.ignoredFiles && deps.ignoredFiles.length > 0
          ? { ignoredFiles: deps.ignoredFiles }
          : {}),
        /*
         * Aggregated prompt for coding agents, grouped like the summary sections so agents can tell
         * blocking from polish. Unresolved prior blocking comes first (they are what blocks approve).
         * Unconfirmed findings are excluded: agents would act on unverified guesses.
         */
        agentPrompts: [
          ...unresolvedPriorBlocking.map((r) => ({
            group: 'unresolved' as const,
            ...(r.path ? { path: r.path } : {}),
            claim: r.claim,
          })),
          ...newVisible
            .filter(isConfirmed)
            .map((f) => ({ group: promptGroup(f), ...promptWhere(f), claim: f.claim })),
          ...persistedVisible.filter(isConfirmed).map((f) => ({
            group: 'previously-reported' as const,
            ...promptWhere(f),
            claim: f.claim,
          })),
          ...[...carried, ...openStillPresent].map((c) => ({
            group: 'previously-reported' as const,
            path: c.path,
            ...(c.line !== undefined ? { line: c.line } : {}),
            claim: c.claim,
          })),
        ],
        ...(deps.botMention !== undefined ? { botMention: deps.botMention } : {}),
        // Every model that served a turn, across stages and fallbacks; ids only, never endpoints or keys.
        models: usage && usage.models.length > 0 ? usage.models : [deps.model.id],
      },
      deps.language,
    );
    const inBody = <T extends object>(input: T) => ({
      tenantId: target.tenantId,
      repositoryId: target.repositoryId,
      changeRequest: target.changeRequest,
      changeRequestId: target.changeRequestId,
      revisionId: target.revisionId,
      revisionSha: target.revisionSha,
      providerHostId: target.providerHostId,
      expectedHeadSha: target.expectedHeadSha,
      ...(target.idempotencyScope ? { idempotencyScope: target.idempotencyScope } : {}),
      ...input,
    });

    // The PR description gets the change walkthrough only, no findings.
    if (hasDescription && (deps.priorReviewedPaths?.length ?? 0) === 0) {
      const changeSummary = renderChangeSummary(
        {
          ...(deps.changeSummary !== undefined ? { changeIntent: deps.changeSummary } : {}),
          // One entry per map scope; split and fallback scopes are execution details.
          changes: walkthroughOf(ledger),
        },
        deps.language,
      );
      await deps.updateSummaryDescription!(changeSummary);
      publishedSummary = true;
    }

    /*
     * One batch review with the summary as body; approve is posted even with 0 comments. Any
     * blocking item forces a visible review so authors see why it was not approved. With description
     * support, new confirmed non-blocking findings that could not be anchored exist only in this body,
     * so they also force a review. A coverage gap alone does not (the body would say nothing useful).
     */
    const reviewBody = summaryBody;
    if (
      inlineComments.length > 0 ||
      event !== 'comment' ||
      blockingCount > 0 ||
      (hasDescription && newNonBlockingNotes)
    ) {
      const batch = await publishReviewBatch(deps.publishContext, {
        ...inBody({}),
        event,
        summaryMarkdown: reviewBody,
        comments: inlineComments,
      });
      if (batch.status === 'published' || batch.status === 'duplicate') resultsPosted = true;
      if (batch.status === 'published') {
        publishedInline = batch.publishedComments ?? inlineComments.length;
        if (!hasDescription) publishedSummary = true; // summary is the review body
      } else if (batch.status === 'degraded' && batch.reason === 'provider_no_batch') {
        for (const c of inlineComments) {
          const r = await publishInlineComment(
            deps.publishContext,
            inBody({ findingId: c.findingId, anchor: c.anchor, bodyMarkdown: c.bodyMarkdown }),
          );
          if (r.status === 'published') publishedInline += 1;
        }
        if (!hasDescription) {
          const s = await publishSummaryComment(
            deps.publishContext,
            inBody({ bodyMarkdown: summaryBody }),
          );
          publishedSummary = s.status === 'published';
        }
        resultsPosted = publishedInline > 0 || publishedSummary;
      }
    } else if (!hasDescription) {
      const s = await publishSummaryComment(
        deps.publishContext,
        inBody({ bodyMarkdown: summaryBody }),
      );
      publishedSummary = s.status === 'published';
      resultsPosted = s.status === 'published' || s.status === 'duplicate';
    }
    // duplicate / superseded / other degraded: idempotent, not re-sent.
  }

  const verifyUsage = sumUsage(staged.map((s) => s.usage));
  const stageUsage = {
    ...(ledger.stageUsage ?? {}),
    ...(verifyUsage ? { verify: verifyUsage } : {}),
  };
  const coveredFiles = coveredFilesOf(produced, deps);

  return {
    candidateCount: ledger.candidates.length,
    findings,
    coverage: ledger.coverage,
    ...(coveredPaths.length > 0 ? { coveredPaths } : {}),
    ...(coveredFiles.length > 0 ? { coveredFiles } : {}),
    ...(deps.reviewContractDigest ? { reviewContractDigest: deps.reviewContractDigest } : {}),
    ...(unreachedPaths !== undefined ? { unreachedPaths } : {}),
    ...(unplannedPaths !== undefined ? { unplannedPaths } : {}),
    ...(deferredPaths !== undefined && deferredPaths.length > 0 ? { deferredPaths } : {}),
    ...(incompleteScopes.length > 0 ? { incompleteScopes } : {}),
    walkthrough: walkthroughOf(ledger),
    reviewEvent: event,
    blockingCount,
    publishedInline,
    publishedSummary,
    resultsPosted,
    ...(usage ? { usage } : {}),
    ...(Object.keys(stageUsage).length > 0 ? { stageUsage } : {}),
    ...(ledger.elidedToolResults ? { elidedToolResults: ledger.elidedToolResults } : {}),
    ...(ledger.memoryCandidates && ledger.memoryCandidates.length > 0
      ? { memoryCandidates: ledger.memoryCandidates }
      : {}),
    ...(ledger.externalFacts && ledger.externalFacts.length > 0 ? { externalFacts: ledger.externalFacts } : {}),
    ...(ledger.externalFactsSubmitted ? { externalFactsSubmitted: ledger.externalFactsSubmitted } : {}),
    ...(resolvedFingerprints.length > 0 ? { resolvedFingerprints } : {}),
    ...(resolvedFindingIds.length > 0 ? { resolvedFindingIds } : {}),
    ...(unresolvedPriorBlocking.length > 0 ? { unresolvedPriorBlocking } : {}),
    ...(staleFindingIds.length > 0 ? { staleFindingIds } : {}),
    ...(unresolvedForDisplay.merged > 0
      ? { unresolvedDuplicatesMerged: unresolvedForDisplay.merged }
      : {}),
    ...(priorMatchTruncated > 0 ? { priorMatchTruncated } : {}),
    ...(priorToReconcile.length > 0
      ? {
          priorReconcile: {
            total: priorToReconcile.length,
            stillPresent: unresolvedPriorBlocking.length,
            resolved: resolvedFindingIds.length,
            notApplicable: resolution.filter((r) => r.status === 'not-applicable').length,
          },
        }
      : {}),
    ...(produced.costCappedCandidates
      ? { costCappedCandidates: produced.costCappedCandidates }
      : {}),
    ...(ledger.costCappedScopes ? { costCappedScopes: ledger.costCappedScopes } : {}),
    ...(produced.deadlineCappedCandidates
      ? { deadlineCappedCandidates: produced.deadlineCappedCandidates }
      : {}),
    ...(suggestionsPublished > 0 || suggestionRejected.length > 0
      ? {
          suggestions: {
            published: suggestionsPublished,
            rejected: suggestionRejected.reduce<Record<string, number>>(
              (acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }),
              {},
            ),
          },
        }
      : {}),
  };
}

/** produceReview + publishReview in one process; in the sandbox path the two run separately. */
export async function runReviewAndPublish(deps: ReviewOrchestratorDeps): Promise<ReviewOutcome> {
  return publishReview(await produceReview(deps), deps);
}
