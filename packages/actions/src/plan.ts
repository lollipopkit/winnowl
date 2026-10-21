import { uuidv7 } from '@reviewbot/ids';
import type { ActionType } from './types.js';

export interface PlannedAction {
  type: ActionType;
  description: string;
  /** For fix actions (create-stacked-pr etc.): used to build the FixPlan. */
  findingIds?: string[];
  /** FixPlan.kind for create-stacked-pr; omitted = autofix. */
  fixKind?: string;
  /** create-cr-from-issue: the issue to implement. */
  issueNumber?: number;
}

export type ActionPlanStatus =
  'proposed' | 'approved' | 'executing' | 'declined' | 'failed' | 'executed' | 'expired';

/**
 * Execution-time revalidation must use the rule the approval was granted under: `console` checks
 * tenant membership; `provider-comment` (`@bot approve`) checks provider permissions, since the
 * commenter may never have logged into the console.
 */
export type ApprovalProvenance =
  | { source: 'console'; actorId: string }
  | { source: 'provider-comment'; actorId: string; login: string; host: string };

export interface ActionPlan {
  id: string;
  conversationId: string;
  actorId: string;
  /** System-generated proposals may be approved by any actor with the required permission. */
  approvalActor?: 'any-authorized';
  /** The provider actor that approved a system-generated proposal. */
  approvedByActorId?: string;
  /** Absent on old rows: treated as console. */
  approval?: ApprovalProvenance;
  /** Optional idempotency identity for proposals representing the same external action. */
  dedupeKey?: string;
  /** Must still match the current head at execution time. */
  revisionSha?: string;
  actions: PlannedAction[];
  requiredPermissions: string[];
  /** epoch ms */
  expiresAt: number;
  status: ActionPlanStatus;
  /** Only returned by the execution claim, never by ordinary reads. */
  executionToken?: string;
}

export interface NewActionPlanInput {
  conversationId: string;
  /** Usually the commenter; by default the approver must be the same actor. */
  actorId: string;
  approvalActor?: 'any-authorized';
  dedupeKey?: string;
  revisionSha?: string;
  actions: PlannedAction[];
  requiredPermissions?: string[];
  /** ms; default 30 minutes. Expired plans cannot be approved. */
  ttlMs?: number;
  now?: number;
  id?: string;
}

/** A proposal has no side effects until approved. */
export function newActionPlan(input: NewActionPlanInput): ActionPlan {
  const now = input.now ?? Date.now();
  return {
    id: input.id ?? uuidv7(input.now),
    conversationId: input.conversationId,
    actorId: input.actorId,
    ...(input.approvalActor !== undefined ? { approvalActor: input.approvalActor } : {}),
    ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.revisionSha !== undefined ? { revisionSha: input.revisionSha } : {}),
    actions: input.actions,
    requiredPermissions: input.requiredPermissions ?? [],
    expiresAt: now + (input.ttlMs ?? 30 * 60_000),
    status: 'proposed',
  };
}

export interface ConfirmationAttempt {
  planId: string;
  actorId: string;
  conversationId: string;
  currentHeadSha?: string;
  now?: number;
}

export interface ExecuteGate {
  ok: boolean;
  reason?: string;
}

/** Same plan, actor and conversation; not expired; head unchanged; repo policy still allows it. */
export function canExecutePlan(
  plan: ActionPlan,
  attempt: ConfirmationAttempt,
  options: { repoAllows: boolean; actorPermissionValid: boolean },
): ExecuteGate {
  const now = attempt.now ?? Date.now();
  if (plan.status !== 'proposed' && plan.status !== 'approved')
    return { ok: false, reason: 'plan not pending' };
  if (plan.id !== attempt.planId) return { ok: false, reason: 'plan id mismatch' };
  if (plan.approvalActor !== 'any-authorized' && plan.actorId !== attempt.actorId)
    return { ok: false, reason: 'actor mismatch' };
  if (plan.conversationId !== attempt.conversationId)
    return { ok: false, reason: 'conversation mismatch' };
  if (now > plan.expiresAt) return { ok: false, reason: 'plan expired' };
  if (plan.revisionSha) {
    if (!attempt.currentHeadSha) return { ok: false, reason: 'current head unavailable' };
    if (plan.revisionSha !== attempt.currentHeadSha) return { ok: false, reason: 'head changed' };
  }
  if (!options.actorPermissionValid) return { ok: false, reason: 'actor permission invalid' };
  if (!options.repoAllows) return { ok: false, reason: 'repo policy denies' };
  return { ok: true };
}
