import type { ChangeRelation } from '@reviewbot/domain';
import { changeRelationCanBlockMerge, isAttributedChangeRelation } from '@reviewbot/domain';
import {
  isAtLeast,
  isHighRiskSeverity,
  NON_BLOCKING_CATEGORIES,
  type ConfirmationLevel,
  type DemotionReason,
  type FindingCategory,
  type PublicationKind,
  type PublicationPlacement,
  type PublicationStatus,
  type Severity,
  type SuppressionReason,
} from './types.js';

export type VerifierDecision = 'accept' | 'reject' | 'uncertain';

export interface PublicationInput {
  severity: Severity;
  category: FindingCategory;
  confirmation: ConfirmationLevel;
  changeRelation: ChangeRelation;
  decision: VerifierDecision;
  actionable: boolean;
  anchorUnique: boolean;
  anchorScore: number;
  /** Whether a high-severity finding was upheld by the Refuter. */
  refuterUpheld?: boolean;
  /** Backed by an explicit repo rule (lets low-severity/style findings through). */
  repoRuleBacked?: boolean;
  /**
   * Minimum confirmation for inline placement; below it the finding is folded. Only affects
   * placement, not the confirmed-vs-low-evidence decision made by `meetsGate`.
   */
  minConfirmation?: ConfirmationLevel;
  /**
   * Whether preexisting issues may block. Default false. Only affects `blocking`, not placement
   * or the confirmation gate.
   */
  blockPreexisting?: boolean;
  /** Severities that block merge when confirmed; defaults to `DEFAULT_BLOCK_ON_SEVERITY`. */
  blockOnSeverity?: readonly Severity[];
}

/** Critical and major defects block; medium (Minor) is reported without holding the merge, `low` is a nitpick. */
export const DEFAULT_BLOCK_ON_SEVERITY: readonly Severity[] = ['critical', 'high'];

/** Severities without functional impact: rendered as nitpicks, never blocking. */
const NITPICK_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(['low', 'info']);

export interface BlockScope {
  blockOnSeverity?: readonly Severity[];
  blockPreexisting?: boolean;
}

/** Facts for nitpick/blocking decisions: from this round's verdict on write, from stored occurrences on read. */
export interface BlockingFacts {
  severity: Severity;
  category: FindingCategory;
  changeRelation: ChangeRelation;
  confirmation: ConfirmationLevel;
  refuterUpheld?: boolean;
  repoRuleBacked?: boolean;
}

/** Polish-level finding: style, non-blocking categories, or no-impact severity. */
export function isNitpick(f: Pick<BlockingFacts, 'severity' | 'category' | 'repoRuleBacked'>): boolean {
  return (
    f.category === 'style' ||
    (NON_BLOCKING_CATEGORIES.has(f.category) && !f.repoRuleBacked) ||
    NITPICK_SEVERITIES.has(f.severity)
  );
}

/**
 * Whether a confirmed finding must be fixed before merge. Shared by the write side
 * (`decidePublication`) and the read side (gate reconciliation), so config changes apply to history.
 *
 * - not a nitpick and severity in `blockOnSeverity`;
 * - caused by this change (introduced / exposed / regressed) unless `blockPreexisting`;
 * - independently endorsed: refuter upheld it, or tool-confirmed evidence (dependency scan).
 */
export function blocksMerge(f: BlockingFacts, scope: BlockScope = {}): boolean {
  return (
    !isNitpick(f) &&
    (scope.blockOnSeverity ?? DEFAULT_BLOCK_ON_SEVERITY).includes(f.severity) &&
    changeRelationCanBlockMerge(f.changeRelation, {
      ...(scope.blockPreexisting !== undefined ? { blockPreexisting: scope.blockPreexisting } : {}),
    }) &&
    ((f.refuterUpheld ?? false) || isAtLeast(f.confirmation, 'tool-confirmed'))
  );
}

/** Publication decision. Whether to publish is derived from `status` (`shouldPublish`). */
export interface PublicationDecision {
  status: PublicationStatus;
  kind: PublicationKind;
  placement: PublicationPlacement;
  /** Must be fixed before merge (request-changes; failing Check Run when the merge gate is on). */
  blocking: boolean;
  reason: string;
  suppression?: SuppressionReason;
  /** Why a confirmed finding is not inline; seeds the demotion chain on the publish side. */
  demotion?: DemotionReason;
}

function refuted(reason: SuppressionReason): PublicationDecision {
  return { status: 'refuted', kind: 'defect', placement: 'folded', blocking: false, reason, suppression: reason };
}

/**
 * Not confirmed (as opposed to refuted): folded and shown as a lead, not hidden.
 * Unverified-risk vs low-evidence grouping is a render-time split by severity.
 */
function unconfirmed(reason: string): PublicationDecision {
  return { status: 'uncertain', kind: 'defect', placement: 'folded', blocking: false, reason };
}

/** Whether an accepted finding meets the confirmation threshold for its severity. */
function meetsGate(input: PublicationInput): boolean {
  // Tool endorsement; verifier self-reports are already clamped to `independently-verified`.
  const strongConfirmed = isAtLeast(input.confirmation, 'tool-confirmed');
  switch (input.severity) {
    case 'critical':
      /*
       * Attribution here only excludes `unknown` (not the blocking rule): a preexisting critical issue
       * is still a confirmed finding, it just doesn't block merge.
       */
      return (
        isAtLeast(input.confirmation, 'independently-verified') &&
        (input.refuterUpheld ?? false) &&
        isAttributedChangeRelation(input.changeRelation)
      );
    case 'high':
      return (
        (isAtLeast(input.confirmation, 'independently-verified') && (input.refuterUpheld ?? false)) ||
        strongConfirmed
      );
    case 'medium':
      return isAtLeast(input.confirmation, 'independently-verified');
    case 'low':
      /*
       * Same as medium: verifier tools are read-only, so `tool-confirmed` is unreachable for most
       * findings. Low severity still does not block.
       */
      return isAtLeast(input.confirmation, 'independently-verified') || (input.repoRuleBacked ?? false);
    default:
      return false; // info
  }
}

/**
 * Publication matrix. Hard gates; scoring only orders findings.
 * - reject / not actionable -> `refuted` (verified false: stored, not shown);
 * - uncertain, or accepted below threshold -> `uncertain` (shown folded, never asserted or blocking);
 * - accepted above threshold -> `confirmed`, inline when the anchor is reliable, otherwise folded.
 *
 * The kind axis (defect/nit) is fixed here; later demotions must not rewrite it.
 */
export function decidePublication(input: PublicationInput): PublicationDecision {
  if (input.decision === 'reject') return refuted('low-evidence');

  if (input.decision === 'uncertain') {
    return unconfirmed(isHighRiskSeverity(input.severity) ? 'high-impact uncertain' : 'uncertain');
  }

  // decision === 'accept'
  if (!input.actionable) return refuted('not-actionable');

  if (!meetsGate(input)) return unconfirmed('below confirmation threshold');

  // Inline requires a reliable anchor and the configured minimum confirmation, if any.
  const inlineOk =
    input.anchorUnique &&
    input.anchorScore >= 0.97 &&
    (input.minConfirmation === undefined || isAtLeast(input.confirmation, input.minConfirmation));
  const belowMinConfirmation =
    input.minConfirmation !== undefined && !isAtLeast(input.confirmation, input.minConfirmation);

  const kind: PublicationKind = isNitpick(input) ? 'nit' : 'defect';
  /*
   * Inline whenever the anchor is reliable; the noise budget already ranks by severity.
   * An unreliable anchor would attach the comment to the wrong line.
   */
  const inlineBlocked: DemotionReason = belowMinConfirmation ? 'below-min-confirmation' : 'anchor-unreliable';
  const placement: PublicationPlacement = inlineOk ? 'inline' : 'folded';
  const demotion: DemotionReason | undefined = inlineOk ? undefined : inlineBlocked;

  const blocking = blocksMerge(input, input);

  return { status: 'confirmed', kind, placement, blocking, reason: 'accepted', ...(demotion ? { demotion } : {}) };
}
