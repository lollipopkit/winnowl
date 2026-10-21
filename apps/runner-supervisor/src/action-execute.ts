import {
  claimActionPlanExecution,
  completeActionPlanExecution,
  heartbeatActionPlanExecution,
  loadActionPlan,
  releaseActionPlanExecution,
  failActionPlanExecution,
  type ActionPlan,
  type PlannedAction,
} from '@reviewbot/actions';
import { LeaseKeeper } from './lease-keeper.js';
import {
  classifyJobError,
  JobExecutionError,
  type JobHandler,
  type JobHandlerDb,
} from './supervisor.js';

/** ActionPlan execution lease (= claimActionPlanExecution default) and renewal interval. */
const ACTION_PLAN_LEASE_MS = 90_000;
const ACTION_PLAN_HEARTBEAT_MS = 30_000;

export interface ActionExecutePayload {
  tenantId: string;
  planId: string;
}

export interface ActionExecuteContext {
  tenantId: string;
  plan: ActionPlan;
  db: JobHandlerDb;
  signal: AbortSignal;
  /** Stable provider idempotency key for this plan action. */
  idempotencyKey: string;
  /** Re-check the short execution lease immediately before external side effects. */
  assertLease: () => Promise<void>;
}

export interface ActionExecuteDeps {
  validatePlan: (
    plan: ActionPlan,
    ctx: { tenantId: string; db: JobHandlerDb },
  ) => Promise<{ ok: boolean; reason?: string }>;
  /** Executes one approved action; index feeds the idempotency key. */
  executeAction: (action: PlannedAction, ctx: ActionExecuteContext, index: number) => Promise<void>;
  /** User-visible notice on the PR/Issue on terminal failure; without it the user only sees an approval with no result. */
  onTerminalFailure?: (
    ctx: { tenantId: string; plan: ActionPlan; db: JobHandlerDb },
    error: unknown,
  ) => Promise<void>;
}

/**
 * action_execute: runs an approved ActionPlan (unapproved → policy_denied). Policy is enforced before
 * enqueueing; nothing is relaxed here.
 */
export function createActionExecuteHandler(deps: ActionExecuteDeps): JobHandler {
  return async ({ job, db, log, signal }) => {
    const payload = job.payload as unknown as ActionExecutePayload;
    if (payload.tenantId !== job.tenantId) {
      throw new JobExecutionError('action_execute tenantId mismatch', 'policy_denied', false);
    }
    const plan = await claimActionPlanExecution(db, payload.tenantId, payload.planId);
    if (!plan) {
      const existing = await loadActionPlan(db, payload.tenantId, payload.planId);
      if (existing?.status === 'executed') {
        log('action plan already claimed', { planId: payload.planId, status: existing.status });
        return;
      }
      if (existing?.status === 'executing') {
        throw new JobExecutionError(
          `action plan execution is still leased: ${payload.planId}`,
          'retryable_runner',
          true,
        );
      }
      throw new JobExecutionError(
        existing
          ? `action plan not approved (status=${existing.status})`
          : `action plan not found: ${payload.planId}`,
        existing ? 'policy_denied' : 'repository_invalid',
        false,
      );
    }
    const executionToken = plan.executionToken!;
    /*
     * Same rule as LeaseKeeper: a renewal that throws or hangs is not a lost lease; only false, or passing
     * `lastConfirmedUntil - margin`, is. Otherwise a network blip would requeue a partially executed plan.
     */
    let executionLeaseLost = false;
    const keeper = new LeaseKeeper({
      leaseMs: ACTION_PLAN_LEASE_MS,
      intervalMs: ACTION_PLAN_HEARTBEAT_MS,
      renew: () => heartbeatActionPlanExecution(db, payload.tenantId, plan.id, executionToken),
      onLost: (error) => {
        executionLeaseLost = true;
        log('action plan execution lease lost', { planId: plan.id, error: error.message });
      },
    });
    keeper.start();
    const assertLease = async (): Promise<void> => {
      if (signal.aborted) executionLeaseLost = true;
      else await keeper.tick();
      if (executionLeaseLost) {
        throw new JobExecutionError(
          `action plan execution lease lost: ${plan.id}`,
          'retryable_runner',
          true,
        );
      }
    };
    let approvalRejected = false;
    try {
      const validation = await deps.validatePlan(plan, { tenantId: payload.tenantId, db });
      if (!validation.ok) {
        approvalRejected = true;
        throw new JobExecutionError(
          `action plan execution rejected: ${validation.reason ?? 'validation failed'}`,
          'policy_denied',
          false,
        );
      }
      await assertLease();
      let index = 0;
      for (const action of plan.actions) {
        await assertLease();
        await deps.executeAction(
          action,
          {
            tenantId: payload.tenantId,
            plan,
            db,
            signal,
            idempotencyKey: `action:${plan.id}:${index}`,
            assertLease,
          },
          index,
        );
        await assertLease();
        index += 1;
      }
      if (
        executionLeaseLost ||
        !(await completeActionPlanExecution(db, payload.tenantId, plan.id, executionToken))
      ) {
        throw new JobExecutionError(
          `action plan execution ownership lost: ${plan.id}`,
          'retryable_runner',
          true,
        );
      }
    } catch (error) {
      const { retryable } = classifyJobError(error);
      const report = async (): Promise<void> => {
        await deps
          .onTerminalFailure?.({ tenantId: payload.tenantId, plan, db }, error)
          .catch((err: unknown) =>
            log('action plan failure report failed', {
              planId: plan.id,
              error: (err as Error)?.message,
            }),
          );
      };
      if (approvalRejected) {
        /*
         * A validation veto voids the approval, not the plan: back to approved with the approver cleared so
         * someone can re-approve. Not terminal, but the user is told.
         */
        await releaseActionPlanExecution(db, payload.tenantId, plan.id, executionToken, undefined, {
          clearApproval: true,
        }).catch(() => false);
        await report();
      } else if (retryable === false || job.attemptCount >= job.maxAttempts) {
        /*
         * No retries left: go terminal (otherwise nobody would claim it again) and tell the user on the PR/Issue.
         */
        await failActionPlanExecution(db, payload.tenantId, plan.id, executionToken).catch(
          () => false,
        );
        await report();
      } else {
        // Retryable: back to approved for the next claim (same approver).
        await releaseActionPlanExecution(db, payload.tenantId, plan.id, executionToken).catch(
          () => false,
        );
      }
      throw error;
    } finally {
      keeper.stop();
    }
    log('action plan executed', { planId: plan.id, actions: plan.actions.length });
  };
}
