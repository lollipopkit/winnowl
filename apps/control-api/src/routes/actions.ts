import {
  confirmActionPlan,
  evaluatePolicy,
  listActionPlans,
  loadActionPlan,
  type ActionRepoPolicy,
} from '@reviewbot/actions';
import type { Db } from '@reviewbot/db';
import { enqueueJob } from '@reviewbot/queue';
import { hasPermission, ROLE_PERMISSIONS } from '@reviewbot/rbac';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../rbac.js';

/** From repository_settings.settings; defaults (propose allowed, confirmation required) when absent. */
async function repoPolicyFor(
  db: Db,
  tenantId: string,
  conversationId: string,
): Promise<ActionRepoPolicy> {
  const conv = await db
    .selectFrom('conversations')
    .select('repository_id')
    .where('id', '=', conversationId)
    .where('tenant_id', '=', tenantId)
    .forShare()
    .executeTakeFirst();
  const row = conv?.repository_id
    ? await db
        .selectFrom('repository_settings')
        .select('settings')
        .where('repository_id', '=', conv.repository_id)
        .where('tenant_id', '=', tenantId)
        .forShare()
        .executeTakeFirst()
    : undefined;
  const s = (row?.settings ?? {}) as {
    actions?: {
      autofix?: { enabled?: boolean; require_confirmation?: boolean };
      create_issue?: { enabled?: boolean; require_confirmation?: boolean };
    };
    merge_gate?: { enabled?: boolean };
  };
  return {
    autofix: {
      enabled: s.actions?.autofix?.enabled ?? true,
      requireConfirmation: s.actions?.autofix?.require_confirmation ?? true,
    },
    createIssue: {
      enabled: s.actions?.create_issue?.enabled ?? true,
      requireConfirmation: s.actions?.create_issue?.require_confirmation ?? true,
    },
    mergeGovernanceEnabled: s.merge_gate?.enabled ?? false,
  };
}

/**
 * Confirmation must match the same actor, conversation and plan, be unexpired, on an unchanged head,
 * and still be allowed by permissions and policy.
 */
export function registerActionRoutes(app: FastifyInstance, db: Db): void {
  app.get(
    '/v1/action-plans',
    { preHandler: requirePermission('review:read') },
    async (req, reply) => {
      const tenantId = req.auth?.tenantId;
      if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
      return listActionPlans(db, tenantId);
    },
  );

  // Commands the fix agent asked to run in its sandbox for this plan, and the gate's decisions (kept 30 days).
  app.get(
    '/v1/action-plans/:id/commands',
    { preHandler: requirePermission('review:read') },
    async (req, reply) => {
      const tenantId = req.auth?.tenantId;
      if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
      const { id } = req.params as { id: string };
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send({ error: 'not_found' });
      const rows = await db
        .selectFrom('agent_commands')
        .select(['id', 'command', 'purpose', 'verdict', 'decided_by', 'rule', 'reason', 'exit_code', 'timed_out', 'oom_killed', 'duration_ms', 'created_at'])
        .where('tenant_id', '=', tenantId)
        .where('job_id', '=', id)
        .orderBy('created_at', 'asc')
        .limit(500)
        .execute();
      return {
        commands: rows.map((r) => ({
          id: r.id,
          command: r.command,
          ...(r.purpose ? { purpose: r.purpose } : {}),
          verdict: r.verdict,
          decidedBy: r.decided_by,
          rule: r.rule,
          reason: r.reason,
          ...(r.exit_code !== null ? { exitCode: r.exit_code } : {}),
          ...(r.timed_out ? { timedOut: true } : {}),
          ...(r.oom_killed ? { oomKilled: true } : {}),
          ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
          createdAt: r.created_at.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/v1/action-plans/:id/confirm',
    { preHandler: requirePermission('action:approve') },
    async (req, reply) => {
      const auth = req.auth;
      const tenantId = auth?.tenantId;
      if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
      if (!auth?.actorId) return reply.code(400).send({ error: 'no_actor_in_context' });

      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { conversationId?: string };
      if (!body.conversationId) return reply.code(400).send({ error: 'conversationId_required' });

      const actorIsRepoAdmin = hasPermission(auth.role, 'action:approve');

      // Approve and enqueue in one transaction so a plan never stays approved without a job.
      const gate = await db.transaction().execute(async (trx) => {
        // Lock the mutable policy/conversation rows in the same transaction that approves the plan,
        // so a concurrent config/head update cannot be approved against an obsolete snapshot.
        const plan = await loadActionPlan(trx, tenantId, id);
        const repoPolicy = await repoPolicyFor(trx, tenantId, body.conversationId!);
        const repoAllows =
          plan !== null &&
          plan.actions.every(
            (action) =>
              evaluatePolicy({ action: action.type, actorIsRepoAdmin, repoPolicy }).allowed,
          );
        const conversation = await trx
          .selectFrom('conversations')
          .select('change_request_id')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', body.conversationId!)
          .forShare()
          .executeTakeFirst();
        let current: { head_sha: string } | undefined;
        if (conversation?.change_request_id) {
          const lockedChange = await trx
            .selectFrom('change_requests')
            .select('id')
            .where('id', '=', conversation.change_request_id)
            .where('tenant_id', '=', tenantId)
            .forShare()
            .executeTakeFirst();
          if (lockedChange) {
            current = await trx
              .selectFrom('revisions')
              .select('head_sha')
              .where('tenant_id', '=', tenantId)
              .where('change_request_id', '=', lockedChange.id)
              .orderBy('created_at', 'desc')
              .executeTakeFirst();
          }
        }
        const result = await confirmActionPlan(
          trx,
          tenantId,
          {
            planId: id,
            actorId: auth.actorId!,
            conversationId: body.conversationId!,
            ...(current ? { currentHeadSha: current.head_sha } : {}),
          },
          {
            repoAllows,
            actorPermissions: [...ROLE_PERMISSIONS[auth.role]],
            // Execution re-checks per channel: console = platform membership, comment = forge write access.
            approval: { source: 'console', actorId: auth.actorId! },
          },
        );
        if (result.ok) {
          await enqueueJob(trx, {
            tenantId,
            type: 'action_execute',
            payload: { tenantId, planId: id },
            dedupeKey: `action-execute:${id}`,
          });
        }
        return result;
      });

      if (!gate.ok)
        return reply.code(409).send({ error: 'confirmation_rejected', reason: gate.reason });
      return { status: 'approved', plan: gate.plan };
    },
  );
}
