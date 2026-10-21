import { toolTextResult, Type, type AgentTool, type ModelTier, type ResolvedModelSource } from '@reviewbot/agent-pi';
import { sql, type Db } from '@reviewbot/db';
import { decideForReview } from '@reviewbot/entitlement';
import { aggregateRecurringFeedback, aggregateRecurringFindings, insertLearningProposal, learningProposalExists, listLearningProposals, newProposal } from '@reviewbot/knowledge';
import { loadRevisionFindings } from './global-learning-propose.js';
import { clamp01, DRAFT_BUDGET, findingsDigest, newUsage, resolveProposeNearDup, runProposeStage, TRIAGE_BUDGET, type ProposeUsage } from './propose-common.js';
import type { JobHandler } from './supervisor.js';

/**
 * learning_propose job (per-repo switch): quota gate → triage → draft (with tenant history search)
 * → dedupe → stored as proposed (proposedBy=auto) for the existing approval flow. Consumes user quota.
 */

export interface LearningProposePayload {
  tenantId: string;
  repositoryId: string;
  revisionId: string;
}

export interface LearningProposeDeps {
  /** Resolves the model source for a tier; null when unconfigured. */
  resolveModel: (tier?: ModelTier) => ResolvedModelSource | null;
}

const TRIAGE_SCHEMA = Type.Object({
  worthLearning: Type.Boolean({ description: 'Whether this review surfaced a reusable rule worth codifying for this repo/org.' }),
  note: Type.String(),
});
const DRAFT_SCHEMA = Type.Object({
  broadness: Type.Union([Type.Literal('repository'), Type.Literal('organization')], {
    description: 'repository = this repo only; organization = applies across the tenant (justify with cross-repo recurrence).',
  }),
  instruction: Type.String({ description: 'The rule, general and actionable.' }),
  rationale: Type.String(),
  locality: Type.Union([Type.Literal('none'), Type.Literal('path')]),
  selector: Type.Optional(Type.String({ description: 'Path glob when locality=path.' })),
  confidence: Type.Number({ description: '0..1 self-assessed confidence.' }),
});

/** Tenant history search tool (cross-repo recurrence decides repo vs org scope). */
function tenantSearchTools(db: Db, tenantId: string): AgentTool[] {
  return [
    {
      name: 'search_tenant_findings',
      description: "Search THIS tenant's recurring review findings (claim + category); high cross-repo recurrence suggests an organization-level rule.",
      label: 'Search tenant findings',
      parameters: Type.Object({ category: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id, params) => {
        const p = params as { category?: string; limit?: number };
        const rows = await aggregateRecurringFindings(db, { tenantId, ...(p.category ? { category: p.category } : {}), ...(p.limit ? { limit: p.limit } : {}) });
        return toolTextResult(rows.map((r) => `[${r.category}] ${r.claim} — ${r.occurrences}× across ${r.repos} repos`).join('\n'), { count: rows.length });
      },
    },
    {
      name: 'search_tenant_feedback',
      description: "Search THIS tenant's recurring user feedback classes with counts.",
      label: 'Search tenant feedback',
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id, params) => {
        const p = params as { limit?: number };
        const rows = await aggregateRecurringFeedback(db, { tenantId, ...(p.limit ? { limit: p.limit } : {}) });
        return toolTextResult(rows.map((r) => `${r.class} — ${r.occurrences}× across ${r.repos} repos`).join('\n'), { count: rows.length });
      },
    },
  ];
}

/**
 * Adds post-review job usage to the revision's latest review_costs row (no new row).
 * Atomic increment: several such jobs may finish for the same revision concurrently.
 */
export async function billRevision(db: Db, revisionId: string, usage: ProposeUsage): Promise<void> {
  if (usage.totalTokens === 0 && usage.costUsd === 0) return;
  const latest = db
    .selectFrom('review_costs')
    .select('id')
    .where('revision_id', '=', revisionId)
    .orderBy('created_at', 'desc')
    .limit(1);
  // No review_costs row → empty subquery, nothing billed.
  await db
    .updateTable('review_costs')
    .set({
      input_tokens: sql`input_tokens + ${usage.inputTokens}`,
      output_tokens: sql`output_tokens + ${usage.outputTokens}`,
      total_tokens: sql`total_tokens + ${usage.totalTokens}`,
      cost_usd: sql`cost_usd + ${usage.costUsd}`,
    })
    .where('id', '=', latest)
    .execute();
}

export function createLearningProposeHandler(deps: LearningProposeDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as LearningProposePayload;

    // Quota gate: over quota (reject/queue) → skip; degrade → cheap tier.
    const gate = await decideForReview(db, payload.tenantId);
    if (gate.block) {
      log('learning-propose skipped: over quota', { tenantId: payload.tenantId, reason: gate.reason });
      return;
    }
    const draftSource = deps.resolveModel(gate.effectiveTier);
    const triageSource = deps.resolveModel('cheap') ?? draftSource;
    if (!draftSource || !triageSource) {
      log('learning-propose: no model configured', { revisionId: payload.revisionId });
      return;
    }

    const usage = newUsage();
    try {
      const findings = await loadRevisionFindings(db, payload.revisionId);
      const digest = findingsDigest(findings);
      const triage = await runProposeStage({
        source: triageSource,
        systemPrompt:
          'You decide whether a completed code review surfaced a reusable rule worth codifying as a learning for THIS repository or its organization (a recurring convention, pitfall, or good practice). Most reviews do NOT. Be conservative. Call submit_triage.',
        task: `Review findings:\n${digest}\n\nDecide worthLearning.`,
        finalization: { name: 'submit_triage', description: 'Submit triage decision.', label: 'Submit triage', schema: TRIAGE_SCHEMA },
        budget: TRIAGE_BUDGET,
        usage,
      });
      if (!triage || !triage.worthLearning) {
        log('learning-propose: triage says no', { revisionId: payload.revisionId });
        return;
      }

      const d = await runProposeStage({
        source: draftSource,
        systemPrompt:
          'You draft ONE candidate learning rule from this review. Choose broadness=repository unless tenant history shows the pattern recurs across multiple repos (then organization). Use the tenant search tools for evidence. Keep it general and actionable. Call submit_finding.',
        task: `Review findings:\n${digest}\n\nInvestigate tenant history, then submit_finding.`,
        tools: tenantSearchTools(db, payload.tenantId),
        finalization: { name: 'submit_finding', description: 'Submit the candidate learning.', label: 'Submit candidate', schema: DRAFT_SCHEMA },
        budget: DRAFT_BUDGET,
        usage,
      });
      if (!d) {
        log('learning-propose: draft incomplete', { revisionId: payload.revisionId });
        return;
      }
      const repositoryId = d.broadness === 'organization' ? null : payload.repositoryId;

      // Two-level dedup: exact normalized match, then semantic near-duplicate (env LLM_DEDUP=embedding|llm)
      // against all proposed/approved rules of the tenant, across scopes.
      if (await learningProposalExists(db, payload.tenantId, { instruction: d.instruction, repositoryId })) {
        log('learning-propose: duplicate, skipped', { revisionId: payload.revisionId });
        return;
      }
      const existing = (await listLearningProposals(db, payload.tenantId, { status: ['proposed', 'approved'] })).map(
        (p) => p.instruction,
      );
      const nearDup = resolveProposeNearDup({ cheapSource: triageSource, usage });
      if (await nearDup(d.instruction, existing)) {
        log('learning-propose: near-duplicate, skipped', { revisionId: payload.revisionId });
        return;
      }

      const proposal = newProposal({
        repositoryId,
        broadness: d.broadness,
        locality: d.locality,
        ...(d.selector !== undefined ? { selector: d.selector } : {}),
        instruction: d.instruction,
        rationale: `${d.rationale}\n\n(自动提案 · 自评置信度 ${clamp01(d.confidence)})`,
        proposedBy: 'auto',
      });
      await insertLearningProposal(db, payload.tenantId, proposal);
      log('learning proposed', { id: proposal.id, broadness: d.broadness, revisionId: payload.revisionId });
    } finally {
      // Spent LLM usage is billed whether or not a proposal was produced.
      await billRevision(db, payload.revisionId, usage);
    }
  };
}
