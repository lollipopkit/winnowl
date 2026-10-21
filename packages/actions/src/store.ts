import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import {
  canExecutePlan,
  type ActionPlan,
  type ActionPlanStatus,
  type ApprovalProvenance,
  type ConfirmationAttempt,
  type ExecuteGate,
  type PlannedAction,
} from './plan.js';

/** proposed -> approved | declined | expired; approved -> executing -> executed | failed. */

/** Unrecognized shapes count as no provenance. */
function parseProvenance(value: unknown): ApprovalProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { source?: unknown; actorId?: unknown; login?: unknown; host?: unknown };
  if (typeof raw.actorId !== 'string') return undefined;
  if (raw.source === 'provider-comment')
    return {
      source: 'provider-comment',
      actorId: raw.actorId,
      login: typeof raw.login === 'string' ? raw.login : '',
      host: typeof raw.host === 'string' ? raw.host : '',
    };
  if (raw.source === 'console') return { source: 'console', actorId: raw.actorId };
  return undefined;
}

interface PlanRow {
  id: string;
  conversation_id: string;
  actor_id: string;
  approval_actor: string | null;
  approved_by_actor_id: string | null;
  approval_provenance: unknown;
  dedupe_key: string | null;
  revision_sha: string | null;
  actions: unknown;
  required_permissions: unknown;
  expires_at: unknown;
  status: string;
}

function mapRow(row: PlanRow): ActionPlan {
  const approval = parseProvenance(row.approval_provenance);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    actorId: row.actor_id,
    ...(row.approval_actor === 'any-authorized'
      ? { approvalActor: 'any-authorized' as const }
      : {}),
    ...(row.approved_by_actor_id !== null ? { approvedByActorId: row.approved_by_actor_id } : {}),
    ...(approval ? { approval } : {}),
    ...(row.dedupe_key !== null ? { dedupeKey: row.dedupe_key } : {}),
    ...(row.revision_sha !== null ? { revisionSha: row.revision_sha } : {}),
    actions: row.actions as unknown as PlannedAction[],
    requiredPermissions: row.required_permissions as unknown as string[],
    expiresAt: (row.expires_at as unknown as Date).getTime(),
    status: row.status as ActionPlanStatus,
  };
}

export async function insertActionPlan(
  db: Db,
  tenantId: string,
  plan: ActionPlan,
  now?: number,
): Promise<void> {
  const at = new Date(now ?? Date.now());
  await db
    .insertInto('action_plans')
    .values({
      id: plan.id,
      tenant_id: tenantId,
      conversation_id: plan.conversationId,
      actor_id: plan.actorId,
      approval_actor: plan.approvalActor ?? null,
      approved_by_actor_id: plan.approvedByActorId ?? null,
      approval_provenance: plan.approval ?? null,
      dedupe_key: plan.dedupeKey ?? null,
      revision_sha: plan.revisionSha ?? null,
      // node-pg would send a JS array as a postgres array, not jsonb.
      actions: JSON.stringify(plan.actions) as unknown as unknown[],
      required_permissions: JSON.stringify(plan.requiredPermissions) as unknown as string[],
      expires_at: new Date(plan.expiresAt),
      status: plan.status,
      created_at: at,
      updated_at: at,
    })
    .execute();
}

export async function loadActionPlan(
  db: Db,
  tenantId: string,
  planId: string,
): Promise<ActionPlan | null> {
  const row = await db
    .selectFrom('action_plans')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', planId)
    .executeTakeFirst();
  return row ? mapRow(row as unknown as PlanRow) : null;
}

/**
 * Atomic approved -> executing claim. The TTL only gates approval, not execution (it counts from
 * the proposal). An expired executing lease can always be reclaimed with a new fencing token.
 */
export async function claimActionPlanExecution(
  db: Db,
  tenantId: string,
  planId: string,
  now = Date.now(),
  leaseSeconds = 90,
): Promise<ActionPlan | null> {
  const at = new Date(now);
  const token = uuidv7(now);
  const expiresAt = new Date(now + Math.max(30, leaseSeconds) * 1000);
  const row = await db.transaction().execute(async (trx) => {
    // Mark unapproved proposals past their TTL as expired (display only).
    await trx
      .updateTable('action_plans')
      .set({ status: 'expired', updated_at: at })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', planId)
      .where('status', '=', 'proposed')
      .where('expires_at', '<=', at)
      .execute();
    return trx
      .updateTable('action_plans')
      .set({
        status: 'executing',
        execution_token: token,
        execution_expires_at: expiresAt,
        updated_at: at,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', planId)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'approved'),
          eb.and([eb('status', '=', 'executing'), eb('execution_expires_at', '<=', at)]),
        ]),
      )
      .returningAll()
      .executeTakeFirst();
  });
  if (!row) return null;
  return { ...mapRow(row as unknown as PlanRow), status: 'executing', executionToken: token };
}

/** Keeps fencing ownership while external side effects run. */
export async function heartbeatActionPlanExecution(
  db: Db,
  tenantId: string,
  planId: string,
  executionToken: string,
  now = Date.now(),
  leaseSeconds = 90,
): Promise<boolean> {
  const result = await db
    .updateTable('action_plans')
    .set({
      execution_expires_at: new Date(now + Math.max(30, leaseSeconds) * 1000),
      updated_at: new Date(now),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', planId)
    .where('status', '=', 'executing')
    .where('execution_token', '=', executionToken)
    .where('execution_expires_at', '>', new Date(now))
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/**
 * Back to approved so the queue can retry. `clearApproval` (validation rejected the approval) also
 * clears the approver and provenance; transient failures keep them for the retry.
 */
export async function releaseActionPlanExecution(
  db: Db,
  tenantId: string,
  planId: string,
  executionToken: string,
  now = Date.now(),
  opts: { clearApproval?: boolean } = {},
): Promise<boolean> {
  const result = await db
    .updateTable('action_plans')
    .set({
      status: 'approved',
      execution_token: null,
      execution_expires_at: null,
      updated_at: new Date(now),
      ...(opts.clearApproval ? { approved_by_actor_id: null, approval_provenance: null } : {}),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', planId)
    .where('status', '=', 'executing')
    .where('execution_token', '=', executionToken)
    .where('execution_expires_at', '>', new Date(now))
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Terminal: the job is out of attempts; a retry needs a new plan. */
export async function failActionPlanExecution(
  db: Db,
  tenantId: string,
  planId: string,
  executionToken: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await db
    .updateTable('action_plans')
    .set({
      status: 'failed',
      execution_token: null,
      execution_expires_at: null,
      updated_at: new Date(now),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', planId)
    .where('status', '=', 'executing')
    .where('execution_token', '=', executionToken)
    .where('execution_expires_at', '>', new Date(now))
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function completeActionPlanExecution(
  db: Db,
  tenantId: string,
  planId: string,
  executionToken: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await db
    .updateTable('action_plans')
    .set({
      status: 'executed',
      execution_token: null,
      execution_expires_at: null,
      updated_at: new Date(now),
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', planId)
    .where('status', '=', 'executing')
    .where('execution_token', '=', executionToken)
    .where('execution_expires_at', '>', new Date(now))
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export interface ConfirmResult extends ExecuteGate {
  plan?: ActionPlan;
}

export async function confirmActionPlan(
  db: Db,
  tenantId: string,
  attempt: ConfirmationAttempt,
  options: {
    repoAllows: boolean;
    actorPermissions: readonly string[];
    /** Selects the execution-time revalidation; default console. */
    approval?: ApprovalProvenance;
  },
): Promise<ConfirmResult> {
  const plan = await loadActionPlan(db, tenantId, attempt.planId);
  if (!plan) return { ok: false, reason: 'plan not found' };
  const allowed = new Set(options.actorPermissions);
  const gate = canExecutePlan(plan, attempt, {
    repoAllows: options.repoAllows,
    actorPermissionValid: plan.requiredPermissions.every((permission) => allowed.has(permission)),
  });
  if (gate.ok) {
    const now = new Date(attempt.now ?? Date.now());
    // Always overwrite the approver: a later approval by someone else must take effect.
    const approval: ApprovalProvenance =
      options.approval ?? { source: 'console', actorId: attempt.actorId };
    const updated = await db
      .updateTable('action_plans')
      .set({
        status: 'approved',
        approved_by_actor_id: approval.actorId,
        approval_provenance: approval,
        updated_at: now,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', plan.id)
      .where('status', 'in', ['proposed', 'approved'])
      .where('expires_at', '>', now)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0)
      return { ok: false, reason: 'plan not pending', plan };
    return {
      ok: true,
      plan: { ...plan, status: 'approved', approvedByActorId: approval.actorId, approval },
    };
  }
  return { ...gate, plan };
}

/** Same approver rule as confirmation: the proposer, or anyone authorized for system proposals. */
export async function declineActionPlan(
  db: Db,
  tenantId: string,
  input: { planId: string; actorId: string; actorAuthorized: boolean; now?: number },
): Promise<{ ok: boolean; reason?: string }> {
  const plan = await loadActionPlan(db, tenantId, input.planId);
  if (!plan) return { ok: false, reason: 'plan not found' };
  const mayDecide = plan.actorId === input.actorId || (plan.approvalActor === 'any-authorized' && input.actorAuthorized);
  if (!mayDecide) return { ok: false, reason: 'actor mismatch' };
  const updated = await db
    .updateTable('action_plans')
    .set({ status: 'declined', updated_at: new Date(input.now ?? Date.now()) })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', plan.id)
    .where('status', '=', 'proposed')
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0 ? { ok: true } : { ok: false, reason: 'plan not pending' };
}

export async function listActionPlans(
  db: Db,
  tenantId: string,
  limit = 100,
  conversationId?: string,
): Promise<ActionPlan[]> {
  let q = db.selectFrom('action_plans').selectAll().where('tenant_id', '=', tenantId);
  if (conversationId !== undefined) q = q.where('conversation_id', '=', conversationId);
  const rows = await q.orderBy('created_at', 'desc').limit(limit).execute();
  return rows.map((row) => mapRow(row as unknown as PlanRow));
}
