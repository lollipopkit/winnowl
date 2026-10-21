export type RepositoryRelationshipKind =
  | 'api-provider'
  | 'api-consumer'
  | 'shared-schema'
  | 'generated-client'
  | 'library-dependent'
  | 'deployment-dependent';

/** proposed (awaiting approval, authorizes nothing) -> active | rejected (lasting veto). */
export type RelationshipStatus = 'proposed' | 'active' | 'rejected';

export interface RepositoryRelationship {
  id: string;
  sourceRepositoryId: string;
  targetRepositoryId: string;
  kind: RepositoryRelationshipKind;
  instructions?: string;
  enabled: boolean;
  status: RelationshipStatus;
  /** `auto:discover` or a user sub; absent for manual upserts. */
  proposedBy?: string;
  /** Shown to the approver. */
  rationale?: string;
}

export type CrossRepoContractKind =
  | 'openapi'
  | 'protobuf'
  | 'graphql'
  | 'sdk-public-interface'
  | 'event-schema'
  | 'database-contract'
  | 'shared-config'
  | 'versioned-library-api';

export interface CrossRepoTrigger {
  kind: CrossRepoContractKind;
  files: string[];
}

export interface CrossRepoFindingAttribution {
  sourceRepositoryId: string;
  consumerRepositoryId: string;
  relationshipKind: RepositoryRelationshipKind;
  /** Cross-repo fixes always get their own action plan/CR. */
  fixRequiresSeparateChangeRequest: true;
}
