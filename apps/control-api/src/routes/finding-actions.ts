import { insertActionPlan, newActionPlan } from '@reviewbot/actions';
import { findOrCreateConversationByTarget } from '@reviewbot/conversation';
import type { Db } from '@reviewbot/db';
import { dismissFindingForChangeRequest, undismissFinding } from '@reviewbot/finding-lifecycle';
import { insertFeedback, insertLearningProposal, newProposal, type FeedbackClass } from '@reviewbot/knowledge';
import { enqueueJob } from '@reviewbot/queue';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requirePermission } from '../rbac.js';

/** Console dismissal reasons, stored as their feedback class. */
const DISMISS_REASONS: Record<string, FeedbackClass> = {
  'false-positive': 'false-positive',
  'not-worth-it': 'not-important',
  'handled-elsewhere': 'already-known',
};

const UUID = /^[0-9a-f-]{36}$/i;

interface Target {
  tenantId: string;
  actorId: string;
  findingId: string;
  repositoryId: string;
  claim: string;
  changeRequestId: string;
  changeNumber: number;
  changeNativeId: string;
  changeKind: string;
  headSha: string;
}

/** The finding and the change request it is acted on; 404 when either is not this tenant's. */
async function targetOf(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<Target | undefined> {
  const tenantId = req.auth?.tenantId;
  const actorId = req.auth?.actorId;
  if (!tenantId || !actorId) {
    void reply.code(400).send({ error: 'no_tenant_or_actor_in_context' });
    return undefined;
  }
  const { id } = req.params as { id: string };
  const { changeRequestId } = (req.body ?? {}) as { changeRequestId?: string };
  if (!UUID.test(id) || !changeRequestId || !UUID.test(changeRequestId)) {
    void reply.code(400).send({ error: 'finding_and_change_request_required' });
    return undefined;
  }
  const row = await db
    .selectFrom('findings as f')
    .innerJoin('change_requests as cr', (join) => join.onRef('cr.repository_id', '=', 'f.repository_id'))
    .select(['f.id', 'f.repository_id', 'f.canonical_claim', 'cr.id as crId', 'cr.number', 'cr.native_id', 'cr.kind'])
    .where('f.tenant_id', '=', tenantId)
    .where('cr.tenant_id', '=', tenantId)
    .where('f.id', '=', id)
    .where('cr.id', '=', changeRequestId)
    .executeTakeFirst();
  if (!row) {
    void reply.code(404).send({ error: 'not_found' });
    return undefined;
  }
  const head = await db
    .selectFrom('revisions')
    .select('head_sha')
    .where('tenant_id', '=', tenantId)
    .where('change_request_id', '=', row.crId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return {
    tenantId,
    actorId,
    findingId: row.id,
    repositoryId: row.repository_id,
    claim: row.canonical_claim,
    changeRequestId: row.crId,
    changeNumber: row.number,
    changeNativeId: row.native_id,
    changeKind: row.kind,
    headSha: head?.head_sha ?? '',
  };
}

async function audit(db: Db, t: Target, action: string, detail: Record<string, unknown>): Promise<void> {
  await db
    .insertInto('audit_events')
    .values({
      id: crypto.randomUUID(),
      tenant_id: t.tenantId,
      actor: t.actorId,
      action,
      target: t.findingId,
      detail: { changeRequestId: t.changeRequestId, ...detail },
      created_at: new Date(),
    })
    .execute();
}

/** The runner owns forge access, so the merge check is recomputed there. */
async function recomputeGate(db: Db, t: Target): Promise<void> {
  await enqueueJob(db, {
    tenantId: t.tenantId,
    type: 'recompute_gate',
    payload: { tenantId: t.tenantId, repositoryId: t.repositoryId, changeRequestId: t.changeRequestId },
    dedupeKey: `recompute-gate:${t.changeRequestId}`,
  });
}

export function registerFindingActionRoutes(app: FastifyInstance, db: Db): void {
  const trigger = { preHandler: requirePermission('review:trigger') };

  app.post('/v1/findings/:id/dismiss', trigger, async (req, reply) => {
    const t = await targetOf(db, req, reply);
    if (!t) return;
    const body = req.body as { reason?: string; proposeRule?: boolean };
    const feedback = DISMISS_REASONS[body.reason ?? ''];
    if (!feedback) return reply.code(400).send({ error: 'invalid_reason' });
    await dismissFindingForChangeRequest(db, {
      tenantId: t.tenantId,
      findingId: t.findingId,
      changeRequestId: t.changeRequestId,
      actor: t.actorId,
      reason: body.reason!,
    });
    await insertFeedback(db, t.tenantId, {
      repositoryId: t.repositoryId,
      class: feedback,
      actor: t.actorId,
      findingId: t.findingId,
    });
    let ruleId: string | undefined;
    if (body.proposeRule) {
      // The rule only takes effect once approved (it goes to the inbox).
      const proposal = newProposal({
        repositoryId: t.repositoryId,
        broadness: 'repository',
        locality: 'none',
        instruction: `Do not report findings like this one: ${t.claim}`,
        rationale: `Dismissed in the console as ${body.reason}.`,
        proposedBy: t.actorId,
      });
      await insertLearningProposal(db, t.tenantId, proposal);
      ruleId = proposal.id;
    }
    await recomputeGate(db, t);
    await audit(db, t, 'finding.dismissed', { reason: body.reason, ...(ruleId ? { ruleId } : {}) });
    return { ok: true, ...(ruleId ? { ruleId } : {}) };
  });

  app.post('/v1/findings/:id/undismiss', trigger, async (req, reply) => {
    const t = await targetOf(db, req, reply);
    if (!t) return;
    const removed = await undismissFinding(db, t.findingId, t.changeRequestId);
    if (!removed) return reply.code(404).send({ error: 'not_dismissed' });
    await recomputeGate(db, t);
    await audit(db, t, 'finding.undismissed', {});
    return { ok: true };
  });

  // Same plan the `@bot fix` command proposes; it is approved from the inbox.
  app.post('/v1/findings/:id/fix', trigger, async (req, reply) => {
    const t = await targetOf(db, req, reply);
    if (!t) return;
    if (!t.headSha) return reply.code(409).send({ error: 'no_revision' });
    const conversation = await findOrCreateConversationByTarget(db, {
      tenantId: t.tenantId,
      target: { kind: 'change-request', nativeId: t.changeNativeId },
      repositoryId: t.repositoryId,
      changeRequestId: t.changeRequestId,
    });
    const plan = newActionPlan({
      conversationId: conversation.id,
      actorId: t.actorId,
      revisionSha: t.headSha,
      actions: [{ type: 'create-stacked-pr', description: t.claim, findingIds: [t.findingId] }],
      requiredPermissions: ['action:approve'],
    });
    await insertActionPlan(db, t.tenantId, plan);
    await audit(db, t, 'action-plan.proposed', { planId: plan.id });
    return reply.code(201).send({ planId: plan.id });
  });
}
