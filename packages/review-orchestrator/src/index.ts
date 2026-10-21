export { runReviewAndPublish, produceReview, publishReview, ReviewIncompleteError } from './orchestrator.js';
export type { ProducedReview, Staged } from './orchestrator.js';
export type { OrchestratorStageModelResolver } from './orchestrator.js';
export type { ReviewOrchestratorDeps, ProcessedFinding, ReviewOutcome, DependencyFindingInput } from './orchestrator.js';
export type { ExplorationScope, ReviewProgress, SubmoduleBump } from '@reviewbot/review-engine';
export { createLlmFindingMatcher, matchPriorFindings } from './match.js';
export type { MatchSubject, MatchPrior, MatchMethod, FindingMatch, FindingMatches, FindingMatcher, FindingMatcherDeps } from './match.js';

export { reconcilePriorBlocking } from './resolution.js';
export type { CarriedFinding, OpenPriorFinding, StaleCandidate } from './orchestrator.js';
export type { PriorBlockingFinding, ResolutionDeps, ResolutionResult, ResolutionStatus, ResolutionMethod } from './resolution.js';
export {
  claimSimilarity,
  nearDuplicateIds,
  mergeSameDefect,
  NEAR_DUP_THRESHOLD,
  cosineSimilarity,
  tokenDiceStrategy,
  createEmbeddingDeduper,
  createLlmDeduper,
  createOpenAICompatibleEmbed,
} from './dedup.js';
export type {
  ClaimSimilarityFn,
  DedupCandidate,
  DedupStrategy,
  EmbeddingDeduperOptions,
  OpenAICompatibleEmbedOptions,
  LlmDeduperDeps,
} from './dedup.js';
export { coerceCategory, coerceSeverity } from './coerce.js';

export { overCostCapUsd } from './orchestrator.js';
export { validateSuggestion } from './suggestion.js';
export type { CommittableSuggestion } from '@reviewbot/verification';
export type { SuggestionCheck, SuggestionContext, SuggestionRejection } from './suggestion.js';
export { reviewStandardsContext } from '@reviewbot/review-engine';
