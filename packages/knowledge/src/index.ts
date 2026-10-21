/** @reviewbot/knowledge: authoritative rules, learnings, feedback, retrieval, agent memory and ecosystem facts. */

export type {
  KnowledgeCategory,
  AuthoritativeSourceKind,
  AuthoritativeRule,
  CommentRef,
  LearningStatus,
  LearningProposal,
  GlobalLearning,
  GlobalLearningDeliberation,
  PanelVote,
  LearningBroadness,
  LearningLocality,
  LearningEnforcement,
  FeedbackClass,
  RetrievalCategory,
  RetrievalItem,
  MemoryKind,
  AgentMemory,
  AgentMemoryStatus,
  MemorySourceComment,
  GlobalLearningSource,
  GlobalLearningAdoption,
  GlobalLearningsPolicy,
} from './types.js';
export { FEEDBACK_CLASSES, MEMORY_KINDS } from './types.js';

export { SOURCE_PRIORITY, collectAuthoritativeRules } from './authoritative.js';
export type { RawAuthoritativeRule } from './authoritative.js';

export { transitionLearning, isLearningActive } from './learning.js';
export type { LearningActor, LearningTransitionInput, LearningTransitionResult } from './learning.js';

export { isFeedbackClass, shouldProposeFromFeedback, insertFeedback, loadFeedbackFor, maybeAutoProposeLearning } from './feedback.js';
export type { FeedbackRecord, ProposeDecision, FeedbackInput, AutoProposeInput, AutoProposeResult } from './feedback.js';

export { RETRIEVAL_ORDER, retrievalRank, orderKnowledge, orderKnowledgeForPaths, matchesGlob } from './retrieval.js';
export type { RetrievalContext } from './retrieval.js';

export {
  insertLearningProposal,
  loadLearningProposal,
  listLearningProposals,
  listLearningProposalsPage,
  learningProposalExists,
  loadApprovedKnowledge,
  loadApplicableKnowledge,
  markLearningsUsed,
  transitionAndPersist,
  newProposal,
} from './store.js';
export type { TransitionAndPersistResult } from './store.js';

export {
  newGlobalLearning,
  insertGlobalLearning,
  loadGlobalLearning,
  listGlobalLearnings,
  listGlobalLearningsPage,
  loadApprovedGlobalLearnings,
  globalLearningExists,
  transitionGlobalLearning,
  upsertGlobalLearningAdoption,
  loadGlobalLearningAdoptions,
  loadGlobalLearningsPolicy,
  listPendingGlobalLearnings,
  adoptionAllows,
} from './global-store.js';

export {
  MEMORY_INDEX_MAX_LINES,
  normalizeMemoryTitle,
  newAgentMemory,
  insertAgentMemory,
  upsertAgentMemory,
  listAgentMemories,
  agentMemoryExists,
  proposedAgentMemoryExists,
  listAgentMemoryProposals,
  decideAgentMemoryProposal,
  archiveAgentMemories,
  archiveExpiredAgentMemories,
  buildMemoryIndex,
} from './memory-store.js';
export type { MemoryIndex, ProposedAgentMemory } from './memory-store.js';

export {
  aggregateRecurringFindings,
  aggregateRecurringFeedback,
  aggregateCrossTenantLearnings,
  aggregatePanel,
} from './aggregate.js';
export type { RecurringFinding, RecurringFeedback, CrossTenantLearning } from './aggregate.js';

export {
  ECOSYSTEM_FACT_ECOSYSTEMS,
  FACT_LIMITS,
  DEFAULT_FACT_TTL_DAYS,
  isFactEcosystem,
  normalizeFactSources,
  insertEcosystemFact,
  loadEcosystemFact,
  listFactsForSubject,
  listEcosystemFactsPage,
  reviewEcosystemFact,
  loadActiveEcosystemFacts,
  defaultFactExpiry,
  manifestEcosystem,
  selectFactsForManifests,
  formatEcosystemFacts,
  factsWithLongDetail,
  FACT_DETAIL_INLINE_MAX,
} from './ecosystem-facts.js';
export type { FactEcosystem, EcosystemFact, EcosystemFactStatus, EcosystemFactOrigin, NewEcosystemFactInput, FactReviewInput, ManifestText, SelectedEcosystemFact } from './ecosystem-facts.js';
export { lockfileEcosystem, parseVersion, resolvedVersion, satisfies } from './versions.js';
export { FACT_FEED_REFRESH_MS, deleteFactFeed, dueFactFeeds, insertFactFeed, listFactFeeds, recordFactFeedRun, updateFactFeed } from './fact-feeds.js';
export type { FactFeed } from './fact-feeds.js';
export type { DependencyFile } from './versions.js';
