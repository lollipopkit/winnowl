// Core domain model: types and pure functions only, no runtime dependencies.

export type { Uuid, ProviderNativeId } from './ids.js';
export { isUuid, isUuidV7 } from './ids.js';

export type {
  ProviderKind,
  ProviderHostRef,
  ChangeRequestCapabilities,
  ProviderNativeRef,
} from './provider.js';
export { PROVIDER_KINDS, isProviderKind, changeRequestHeadRef, CHANGE_REQUEST_CAPABILITY_KEYS } from './provider.js';

export type {
  RepositoryRef,
  IssueRef,
  ChangeRequestRef,
  Revision,
  Actor,
  ChangeTrust,
  ChangeRequest,
} from './repository.js';
export { isForkTrust } from './repository.js';

export type { CodeReference, SymbolIdentity, SemanticAnchor } from './code.js';

export type { BlockScopeOptions, ChangeRelation } from './relation.js';
export {
  CHANGE_RELATIONS,
  changeRelationCanBlockMerge,
  isAttributedChangeRelation,
  isChangeCausedRelation,
} from './relation.js';
export { SAAS_ORIGINS, normalizeIssuerOrigin, providerIssuer, sameIdentity } from './identity.js';
export type { IdentityRef } from './identity.js';
export { botName, botMention, isOwnBotLogin, isBotActor } from './bot.js';
export {
  REVIEW_TRIGGER_MARKER,
  reviewTriggerCheckbox,
  reviewTriggerTicked,
  triggerCheckbox,
  triggerTicked,
  type TriggerKind,
} from './review-trigger.js';
export { REVIEW_STAGES, STAGE_STRATEGIES, isReviewStage, isStageStrategy, pickStageModelIndex } from './stage-models.js';
export type { ReviewStage, StageStrategy } from './stage-models.js';
