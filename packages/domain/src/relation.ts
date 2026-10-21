/**
 * How a finding relates to the change:
 * - introduced: caused directly by added/modified code;
 * - exposed: an old issue the change made reachable;
 * - regressed: correct behaviour the change broke;
 * - preexisting-relevant: old issue strongly related to the changed area;
 * - preexisting-unrelated: old issue with no causal link to the change;
 * - unknown: cannot be attributed.
 */
export type ChangeRelation =
  | 'introduced'
  | 'exposed'
  | 'regressed'
  | 'preexisting-relevant'
  | 'preexisting-unrelated'
  | 'unknown';

export const CHANGE_RELATIONS: readonly ChangeRelation[] = [
  'introduced',
  'exposed',
  'regressed',
  'preexisting-relevant',
  'preexisting-unrelated',
  'unknown',
];

/**
 * Whether the Verifier attributed the finding at all. Separate from merge blocking
 * (a policy, see `changeRelationCanBlockMerge`); used by the high-severity confirmation gate.
 */
export function isAttributedChangeRelation(relation: ChangeRelation): boolean {
  return relation !== 'unknown';
}

/** Blocking scope policy (`reviews.block_preexisting`). */
export interface BlockScopeOptions {
  /** true = preexisting issues can block too; default = only change-caused ones. */
  blockPreexisting?: boolean;
}

/**
 * Whether a finding with this relation may block merge. By default only change-caused
 * issues block; preexisting ones are still reported. `unknown` never blocks under either policy.
 */
export function changeRelationCanBlockMerge(
  relation: ChangeRelation,
  opts?: BlockScopeOptions,
): boolean {
  return opts?.blockPreexisting === true
    ? isAttributedChangeRelation(relation)
    : isChangeCausedRelation(relation);
}

/** Introduced, exposed or regressed by this change. */
export function isChangeCausedRelation(relation: ChangeRelation): boolean {
  return relation === 'introduced' || relation === 'exposed' || relation === 'regressed';
}
