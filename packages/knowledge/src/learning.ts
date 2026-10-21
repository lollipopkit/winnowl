import type { LearningProposal } from './types.js';

export interface LearningActor {
  /** Tenant admin or owner: approves everything scoped to the tenant (repository/organization/user). */
  isTenantAdmin: boolean;
  /** Required to approve global knowledge. Defaults to false. */
  isPlatformOperator?: boolean;
  /** Repository the actor administers on the forge (admin/maintain): approves that repository's own learnings. */
  repositoryAdminOf?: string;
  /** `provider:id` of the actor: approves user learnings about themselves. */
  subjectRef?: string;
  ref: string;
}

/**
 * Approval by scope: knowledge that only reaches one tenant (repository / organization / user)
 * is approved by that tenant's admins, a repository's own learnings also by its forge admins and a user's
 * own learnings by that user (callers grant both only to trusted forge actors); global
 * knowledge, which reaches every tenant, only by a platform operator.
 */
function canApprove(proposal: LearningProposal, actor: LearningActor | undefined): boolean {
  if (!actor) return false;
  if (proposal.broadness === 'global') return actor.isPlatformOperator === true;
  if (
    proposal.broadness === 'repository' &&
    actor.repositoryAdminOf !== undefined &&
    actor.repositoryAdminOf === proposal.repositoryId
  ) {
    return true;
  }
  if (proposal.broadness === 'user' && actor.subjectRef !== undefined && actor.subjectRef === proposal.subjectRef) return true;
  return actor.isTenantAdmin;
}

function denyReason(broadness: LearningProposal['broadness']): string {
  if (broadness === 'global') return 'only a platform operator can approve global knowledge';
  return 'only a tenant admin can approve';
}

export interface LearningTransitionInput {
  action: 'approve' | 'reject' | 'revoke' | 'expire';
  actor?: LearningActor;
  /** Epoch ms, used for expiry. */
  now?: number;
}

export interface LearningTransitionResult {
  ok: boolean;
  proposal?: LearningProposal;
  reason?: string;
}

/**
 * proposed -> approved/rejected; approved -> revoked/expired. approve/reject/revoke are authorised
 * by broadness (canApprove); expire is triggered by the system after expiry.
 */
export function transitionLearning(
  proposal: LearningProposal,
  input: LearningTransitionInput,
): LearningTransitionResult {
  const now = input.now ?? Date.now();
  switch (input.action) {
    case 'approve':
      if (proposal.status !== 'proposed') return deny('仅 proposed 可 approve');
      if (!canApprove(proposal, input.actor)) return deny(denyReason(proposal.broadness));
      return ok({
        ...proposal,
        status: 'approved',
        approvedBy: input.actor!.ref,
        approvedAt: now,
        version: proposal.version + 1,
      });
    case 'reject':
      if (proposal.status !== 'proposed') return deny('仅 proposed 可 reject');
      if (!canApprove(proposal, input.actor)) return deny(denyReason(proposal.broadness));
      return ok({ ...proposal, status: 'rejected' });
    case 'revoke':
      if (proposal.status !== 'approved') return deny('仅 approved 可 revoke');
      if (!canApprove(proposal, input.actor)) return deny(denyReason(proposal.broadness));
      return ok({ ...proposal, status: 'revoked', version: proposal.version + 1 });
    case 'expire':
      if (proposal.status !== 'approved') return deny('仅 approved 可 expire');
      if (proposal.expiresAt === undefined || now < proposal.expiresAt) return deny('未到期');
      return ok({ ...proposal, status: 'expired' });
  }
}

export function isLearningActive(proposal: LearningProposal, now: number = Date.now()): boolean {
  if (proposal.status !== 'approved') return false;
  if (proposal.expiresAt !== undefined && now >= proposal.expiresAt) return false;
  return true;
}

function ok(proposal: LearningProposal): LearningTransitionResult {
  return { ok: true, proposal };
}
function deny(reason: string): LearningTransitionResult {
  return { ok: false, reason };
}
