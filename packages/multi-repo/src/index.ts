export type {
  RepositoryRelationship,
  RepositoryRelationshipKind,
  RelationshipStatus,
  CrossRepoContractKind,
  CrossRepoTrigger,
  CrossRepoFindingAttribution,
} from './types.js';

export { detectCrossRepoTriggers } from './trigger.js';

export { evaluateCrossRepoAccess, attributeCrossRepoFinding } from './permission.js';
export type { CrossRepoAccessInput, CrossRepoAccess } from './permission.js';

export { upsertRelationship, loadEnabledRelationships, listRelationships, setRelationshipEnabled, proposeRelationship, transitionRelationship } from './store.js';
export type { UpsertRelationshipInput } from './store.js';

export {
  proposeCrossTenantRelationship,
  decideCrossTenantRelationship,
  loadActiveCrossTenantForSource,
  listCrossTenantRelationships,
} from './cross-tenant.js';
export type { CrossTenantRelationship, CrossTenantStatus, CrossTenantDecision, ProposeCrossTenantInput } from './cross-tenant.js';
export {
  recordCrossTenantEvent,
  pendingCrossTenantEvents,
  markCrossTenantEventConsumed,
  failCrossTenantEvent,
  CROSS_TENANT_EVENT_MAX_ATTEMPTS,
} from './cross-tenant.js';
export type { CrossTenantEvent } from './cross-tenant.js';
export { createCrossTenantInvite, verifyCrossTenantInvite } from './cross-tenant-invite.js';
export type { CrossTenantInvitePayload } from './cross-tenant-invite.js';

export { parseManifest, matchRelationships, MANIFEST_FILENAMES } from './discovery.js';
export type { PackageRef, ManifestPackages, RelationshipProposal, RepositoryPackageRow } from './discovery.js';
