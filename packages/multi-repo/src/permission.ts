import type { RepositoryRelationship, CrossRepoFindingAttribution } from './types.js';

export interface CrossRepoAccessInput {
  relationship: RepositoryRelationship;
  sameTenant: boolean;
  explicitlyShared: boolean;
}

export interface CrossRepoAccess {
  allowed: boolean;
  readOnly: true;
  reasons: string[];
}

/** Same tenant or explicitly shared, and enabled; otherwise the target's code is never sent to a model. */
export function evaluateCrossRepoAccess(input: CrossRepoAccessInput): CrossRepoAccess {
  const reasons: string[] = [];
  if (!input.relationship.enabled) reasons.push('关系未启用');
  if (!input.sameTenant && !input.explicitlyShared) reasons.push('非同一 tenant 且无明确共享授权');
  return { allowed: reasons.length === 0, readOnly: true, reasons };
}

export function attributeCrossRepoFinding(
  relationship: RepositoryRelationship,
): CrossRepoFindingAttribution {
  return {
    sourceRepositoryId: relationship.sourceRepositoryId,
    consumerRepositoryId: relationship.targetRepositoryId,
    relationshipKind: relationship.kind,
    fixRequiresSeparateChangeRequest: true,
  };
}
