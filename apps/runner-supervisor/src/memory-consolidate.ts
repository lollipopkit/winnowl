import { detectInjectionAttempt, Type, type ModelTier, type ResolvedModelSource } from '@reviewbot/agent-pi';
import { decideForReview } from '@reviewbot/entitlement';
import {
  archiveAgentMemories,
  archiveExpiredAgentMemories,
  learningProposalExists,
  insertLearningProposal,
  listAgentMemories,
  newAgentMemory,
  newProposal,
  normalizeMemoryTitle,
  upsertAgentMemory,
} from '@reviewbot/knowledge';
import { billRevision } from './learning-propose.js';
import { DRAFT_BUDGET, newUsage, runProposeStage } from './propose-common.js';
import type { JobHandler } from './supervisor.js';

/**
 * memory_consolidate job, triggered when a repo's active memories exceed the index cap.
 * Archives expired entries (no LLM), then applies an LLM plan: merge near-duplicates, archive stale,
 * promote recurring false-positive patterns to learning proposals (human review). Billed to the triggering revision.
 */

export interface MemoryConsolidatePayload {
  tenantId: string;
  repositoryId: string;
  /** Triggering revision (for billing). */
  revisionId: string;
}

export interface MemoryConsolidateDeps {
  resolveModel: (tier?: ModelTier) => ResolvedModelSource | null;
}

const PLAN_SCHEMA = Type.Object({
  merges: Type.Array(
    Type.Object({
      keep: Type.String({ description: 'Title of the entry to keep (must exist).' }),
      drop: Type.Array(Type.String(), { description: 'Titles merged into keep (archived).' }),
      summary: Type.Optional(Type.String({ description: 'Updated one-line summary for keep after merging.' })),
      body: Type.Optional(Type.String({ description: 'Updated body for keep after merging.' })),
    }),
    { description: 'Near-duplicate groups to merge.' },
  ),
  archive: Type.Array(Type.String(), { description: 'Titles that are stale/no longer useful (archived).' }),
  promote: Type.Array(
    Type.Object({
      title: Type.String({ description: 'Source memory title.' }),
      instruction: Type.String({ description: 'The rule, general and actionable, for a learning proposal.' }),
      rationale: Type.String(),
    }),
    { description: 'Recurring patterns mature enough to become governed learnings (human-approved).' },
  ),
});

export function createMemoryConsolidateHandler(deps: MemoryConsolidateDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as MemoryConsolidatePayload;

    const expired = await archiveExpiredAgentMemories(db, payload.tenantId, payload.repositoryId);
    if (expired > 0) log('memory-consolidate: expired archived', { repositoryId: payload.repositoryId, count: expired });

    const memories = await listAgentMemories(db, payload.tenantId, payload.repositoryId);
    if (memories.length < 2) return; // nothing to consolidate

    // Quota gate: LLM consolidation consumes user quota.
    const gate = await decideForReview(db, payload.tenantId);
    if (gate.block) {
      log('memory-consolidate skipped: over quota', { tenantId: payload.tenantId, reason: gate.reason });
      return;
    }
    const source = deps.resolveModel(gate.effectiveTier);
    if (!source) {
      log('memory-consolidate: no model configured', { repositoryId: payload.repositoryId });
      return;
    }

    const usage = newUsage();
    try {
      const listed = memories.map((m) => `- [${m.kind}] ${m.title} — ${m.summary}\n  ${m.body.slice(0, 300)}`).join('\n');
      const plan = await runProposeStage({
        source,
        systemPrompt:
          'You consolidate an agent memory store for one repository: merge near-duplicate entries (same fact in different words), archive stale/no-longer-useful entries, and promote recurring false-positive patterns that have matured into codifiable rules to learning proposals (human-approved). Be conservative: when unsure, keep entries untouched. Call submit_plan.',
        task: `Current memories (${memories.length}):\n${listed}\n\nSubmit the consolidation plan.`,
        finalization: { name: 'submit_plan', description: 'Submit the consolidation plan.', label: 'Submit plan', schema: PLAN_SCHEMA },
        budget: DRAFT_BUDGET,
        usage,
      });
      if (!plan) {
        log('memory-consolidate: plan incomplete', { repositoryId: payload.repositoryId });
        return;
      }

      const byTitle = new Map(memories.map((m) => [m.title, m]));

      // merge: only when keep exists; drop is archived.
      for (const m of plan.merges) {
        const keep = byTitle.get(normalizeMemoryTitle(m.keep));
        if (!keep) continue;
        const drops = m.drop.map(normalizeMemoryTitle).filter((t) => t !== keep.title && byTitle.has(t));
        if (drops.length > 0) await archiveAgentMemories(db, payload.tenantId, payload.repositoryId, drops);
        if (m.summary !== undefined || m.body !== undefined) {
          const summary = (m.summary ?? keep.summary).slice(0, 240);
          const body = (m.body ?? keep.body).slice(0, 2000);
          if (detectInjectionAttempt(`${summary}\n${body}`).suspicious) continue;
          await upsertAgentMemory(
            db,
            payload.tenantId,
            payload.repositoryId,
            newAgentMemory({ kind: keep.kind, title: keep.title, summary, body, ...(keep.selector !== undefined ? { selector: keep.selector } : {}), originReviewId: payload.revisionId }),
          );
        }
        log('memory-consolidate: merged', { keep: keep.title, dropped: drops.length });
      }

      // archive: reversible, so a wrong call can be restored.
      const staleTitles = plan.archive.map(normalizeMemoryTitle).filter((t) => byTitle.has(t));
      if (staleTitles.length > 0) {
        await archiveAgentMemories(db, payload.tenantId, payload.repositoryId, staleTitles);
        log('memory-consolidate: stale archived', { count: staleTitles.length });
      }

      // promote: goes through human review as a learning proposal.
      for (const p of plan.promote) {
        if (!byTitle.has(normalizeMemoryTitle(p.title))) continue;
        const instruction = p.instruction.slice(0, 2000);
        const rationale = p.rationale.slice(0, 2000);
        if (!instruction.trim() || detectInjectionAttempt(`${instruction}\n${rationale}`).suspicious) continue;
        if (await learningProposalExists(db, payload.tenantId, { instruction, repositoryId: payload.repositoryId })) continue;
        const proposal = newProposal({
          repositoryId: payload.repositoryId,
          broadness: 'repository',
          locality: 'none',
          instruction,
          rationale: `${rationale}\n\n(记忆巩固升级提案 · 源记忆「${normalizeMemoryTitle(p.title)}」)`,
          proposedBy: 'auto',
        });
        await insertLearningProposal(db, payload.tenantId, proposal);
        log('memory-consolidate: promoted to learning proposal', { id: proposal.id, from: p.title });
      }
    } finally {
      await billRevision(db, payload.revisionId, usage);
    }
  };
}
