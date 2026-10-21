import { toolTextResult, Type, type AgentTool, type Model, type StreamFn } from '@reviewbot/agent-pi';
import type { Db } from '@reviewbot/db';
import {
  aggregateCrossTenantLearnings,
  aggregatePanel,
  aggregateRecurringFeedback,
  aggregateRecurringFindings,
  globalLearningExists,
  insertGlobalLearning,
  listGlobalLearnings,
  newGlobalLearning,
  type GlobalLearningDeliberation,
  type PanelVote,
} from '@reviewbot/knowledge';
import { clamp01, DRAFT_BUDGET, findingsDigest, newUsage, resolveProposeNearDup, runProposeStage, TRIAGE_BUDGET } from './propose-common.js';
import type { JobHandler } from './supervisor.js';

/**
 * global_learning_propose job, enqueued after a review (no user quota): triage → draft (agent + platform
 * aggregate search) → panel vote (one per model) → stored as proposed (origin=auto) for operator approval.
 * LLM usage goes to deliberation.usage, not review_costs/quota.
 */

export interface GlobalLearningProposePayload {
  tenantId: string;
  repositoryId: string;
  revisionId: string;
}

interface ModelSource {
  model: Model<string>;
  streamFn: StreamFn;
}

export interface GlobalLearningModels {
  /** Draft model (agent + search tools); also used for triage unless triageModel is given. */
  draftModel: ModelSource;
  triageModel?: ModelSource;
  /** Panel models, one vote each. */
  panelModels: { id: string; source: ModelSource }[];
}

export interface GlobalLearningProposeDeps {
  /** Resolved per job so model and panel settings apply without a restart; null = nothing to run with. */
  resolveModels: (db: Db) => Promise<GlobalLearningModels | null>;
}

const TRIAGE_SCHEMA = Type.Object({
  worthGlobal: Type.Boolean({ description: 'Whether this review surfaced a generalizable, cross-project-worthy lesson.' }),
  signalKind: Type.Union([Type.Literal('design'), Type.Literal('cve'), Type.Literal('pitfall'), Type.Literal('none')]),
  note: Type.String(),
});
const DRAFT_SCHEMA = Type.Object({
  instruction: Type.String({ description: 'The global rule, general and actionable, applying to all projects.' }),
  rationale: Type.String(),
  locality: Type.Union([Type.Literal('none'), Type.Literal('path')]),
  selector: Type.Optional(Type.String({ description: 'Path glob when locality=path.' })),
  evidence: Type.Array(Type.String({ description: 'Concrete supporting clues found via platform search.' })),
});
const VOTE_SCHEMA = Type.Object({
  decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
  confidence: Type.Number({ description: '0..1 confidence in the decision.' }),
  reasoning: Type.String(),
});

export async function loadRevisionFindings(db: Db, revisionId: string): Promise<{ claim: string; category: string; severity: string }[]> {
  const rows = await db
    .selectFrom('finding_occurrences')
    .innerJoin('findings', 'findings.id', 'finding_occurrences.finding_id')
    .select(['findings.canonical_claim as claim', 'findings.category as category', 'finding_occurrences.severity as severity'])
    .where('finding_occurrences.revision_id', '=', revisionId)
    .execute();
  return rows.map((r) => ({ claim: r.claim, category: r.category, severity: r.severity }));
}

/** Platform-wide aggregate search tool (cross-tenant, returns aggregates only, never raw text). */
function platformSearchTools(db: Db): AgentTool[] {
  return [
    {
      name: 'search_recurring_findings',
      description: 'Search platform-wide recurring review findings (claim + category) with occurrence and tenant counts.',
      label: 'Search recurring findings',
      parameters: Type.Object({ category: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id, params) => {
        const p = params as { category?: string; limit?: number };
        const rows = await aggregateRecurringFindings(db, { ...(p.category ? { category: p.category } : {}), ...(p.limit ? { limit: p.limit } : {}) });
        return toolTextResult(rows.map((r) => `[${r.category}] ${r.claim} — ${r.occurrences}× across ${r.tenants} tenants`).join('\n'), { count: rows.length });
      },
    },
    {
      name: 'search_recurring_feedback',
      description: 'Search platform-wide recurring user feedback classes with counts.',
      label: 'Search recurring feedback',
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id, params) => {
        const p = params as { limit?: number };
        const rows = await aggregateRecurringFeedback(db, { ...(p.limit ? { limit: p.limit } : {}) });
        return toolTextResult(rows.map((r) => `${r.class} — ${r.occurrences}× across ${r.tenants} tenants`).join('\n'), { count: rows.length });
      },
    },
    {
      name: 'search_cross_tenant_learnings',
      description: 'Search approved learnings whose instruction recurs across multiple tenants (candidates to promote to global).',
      label: 'Search cross-tenant learnings',
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id, params) => {
        const p = params as { limit?: number };
        const rows = await aggregateCrossTenantLearnings(db, { ...(p.limit ? { limit: p.limit } : {}) });
        return toolTextResult(rows.map((r) => `(${r.tenants} tenants) ${r.instruction}`).join('\n'), { count: rows.length });
      },
    },
  ];
}

export function createGlobalLearningProposeHandler(resolver: GlobalLearningProposeDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as GlobalLearningProposePayload;
    const deps = await resolver.resolveModels(db);
    if (!deps) {
      log('global-learning skipped: no draft or panel model', { revisionId: payload.revisionId });
      return;
    }
    const usage = newUsage();

    // Triage: most reviews have nothing generalizable, so exit early on a cheap model.
    const findings = await loadRevisionFindings(db, payload.revisionId);
    const digest = findingsDigest(findings);
    const triageModel = deps.triageModel ?? deps.draftModel;
    const t = await runProposeStage({
      source: triageModel,
      systemPrompt:
        'You decide whether a completed code review surfaced a GENERALIZABLE lesson worth a cross-project (global) learning rule — e.g. a good design pattern, a newly discovered third-party library CVE, or a recurring pitfall. Most reviews do NOT. Be conservative; when unsure, set worthGlobal=false. Call submit_triage.',
      task: `Review findings for this change:\n${digest}\n\nDecide worthGlobal.`,
      finalization: { name: 'submit_triage', description: 'Submit triage decision.', label: 'Submit triage', schema: TRIAGE_SCHEMA },
      budget: TRIAGE_BUDGET,
      usage,
    });
    if (!t) {
      log('global-learning triage incomplete', { revisionId: payload.revisionId });
      return;
    }
    if (!t.worthGlobal) {
      log('global-learning triage: not worth global', { revisionId: payload.revisionId, note: t.note });
      return;
    }

    const d = await runProposeStage({
      source: deps.draftModel,
      systemPrompt:
        'You draft ONE candidate GLOBAL learning rule that applies to ALL projects (not one repo). Before proposing, use the platform search tools to find evidence that the pattern recurs across tenants; cite concrete evidence. Keep the rule general, actionable, and non-obvious. If nothing is broadly worthwhile, still submit your best candidate with weak evidence noted. Call submit_finding.',
      task: `Triage signal: ${t.signalKind} — ${t.note}\nReview findings:\n${digest}\n\nInvestigate platform history, then submit_finding.`,
      tools: platformSearchTools(db),
      finalization: { name: 'submit_finding', description: 'Submit the candidate global learning.', label: 'Submit candidate', schema: DRAFT_SCHEMA },
      budget: DRAFT_BUDGET,
      usage,
    });
    if (!d) {
      log('global-learning draft incomplete', { revisionId: payload.revisionId });
      return;
    }

    // Two-level dedup: exact normalized match, then semantic near-duplicate (env LLM_DEDUP=embedding|llm).
    if (await globalLearningExists(db, d.instruction)) {
      log('global-learning duplicate, skipped', { revisionId: payload.revisionId });
      return;
    }
    const existing = (await listGlobalLearnings(db)).filter((g) => g.status === 'proposed' || g.status === 'approved').map((g) => g.instruction);
    const nearDup = resolveProposeNearDup({ cheapSource: triageModel, usage });
    if (await nearDup(d.instruction, existing)) {
      log('global-learning near-duplicate, skipped', { revisionId: payload.revisionId });
      return;
    }

    // Panel: models vote concurrently; a failed or unfinished model abstains.
    const candidateText = `Instruction: ${d.instruction}\nRationale: ${d.rationale}\nEvidence:\n${d.evidence.map((e) => `- ${e}`).join('\n')}`;
    const results = await Promise.all(
      deps.panelModels.map(async (pm) => {
        try {
          const vote = await runProposeStage({
            source: pm.source,
            systemPrompt:
              'You are one reviewer on a panel judging a proposed GLOBAL learning rule (applies to all projects). Independently decide approve or reject, with a confidence in [0,1] and concise reasoning. Reject if it is too specific, unverified, or not broadly applicable. Call submit_vote.',
            task: `${candidateText}\n\nSubmit your vote.`,
            finalization: { name: 'submit_vote', description: 'Submit your vote.', label: 'Submit vote', schema: VOTE_SCHEMA },
            budget: TRIAGE_BUDGET,
            usage,
          });
          if (!vote) return null;
          return { model: pm.id, decision: vote.decision, confidence: clamp01(vote.confidence), reasoning: vote.reasoning } as PanelVote;
        } catch (err) {
          log('global-learning panel model failed', { model: pm.id, error: String(err) });
          return null;
        }
      }),
    );
    const votes: PanelVote[] = results.filter((v): v is PanelVote => v !== null);

    const aggregate = aggregatePanel(votes);
    const deliberation: GlobalLearningDeliberation = {
      signal: { kind: t.signalKind, note: t.note },
      evidence: d.evidence,
      draftModel: deps.draftModel.model.id,
      panel: votes,
      aggregate,
      usage,
    };
    const g = newGlobalLearning({
      locality: d.locality,
      ...(d.selector !== undefined ? { selector: d.selector } : {}),
      instruction: d.instruction,
      rationale: d.rationale,
      proposedBy: 'system',
      origin: 'auto',
      confidence: aggregate.confidence,
      deliberation,
      // Structured provenance (operator-only; stripped from tenant projections).
      source: { triggerTenantId: payload.tenantId, triggerRevisionId: payload.revisionId },
    });
    await insertGlobalLearning(db, g);
    log('global-learning proposed', { id: g.id, confidence: aggregate.confidence, approvals: aggregate.approvals, total: aggregate.total });
  };
}
