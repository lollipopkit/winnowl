import { platformSetting } from '@reviewbot/config';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import type { Db } from '@reviewbot/db';
import { enqueueJob } from '@reviewbot/queue';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';

/**
 * Enqueues post-review knowledge jobs (async, never block publishing). Global learning uses no user quota;
 * tenant learning and agent memory are per-repo and consume quota; ecosystem facts need operator approval.
 */
export async function enqueueKnowledgeJobs(
  db: Db,
  review: { tenantId: string; repositoryId: string; revisionId: string },
  outcome: Pick<ReviewOutcome, 'memoryCandidates' | 'externalFacts'>,
): Promise<void> {
  const { tenantId, repositoryId, revisionId } = review;
  const base = { tenantId, repositoryId, revisionId };
  if ((await platformSetting(db, 'knowledge.global_auto_propose')) === 'on') {
    await enqueueJob(db, { tenantId, type: 'global_learning_propose', payload: base, dedupeKey: `gl-propose:${revisionId}` });
  }
  const cfg = await loadEffectiveConfig(db, tenantId, repositoryId);
  if (cfg.knowledge.learnings.auto_propose_from_review) {
    await enqueueJob(db, { tenantId, type: 'learning_propose', payload: base, dedupeKey: `learning-propose:${revisionId}` });
  }
  // Agent memory: upserted without human review, used as soft reference.
  if (cfg.knowledge.memory.enabled) {
    await enqueueJob(db, {
      tenantId,
      type: 'memory_propose',
      payload: {
        ...base,
        ...(outcome.memoryCandidates && outcome.memoryCandidates.length > 0 ? { memoryCandidates: outcome.memoryCandidates } : {}),
      },
      dedupeKey: `memory-propose:${revisionId}`,
    });
  }
  // Ecosystem facts ignore the per-repo switch: they are public, sourced, and gated by operator approval.
  if (outcome.externalFacts && outcome.externalFacts.length > 0) {
    await enqueueJob(db, {
      tenantId,
      type: 'ecosystem_fact_propose',
      payload: { ...base, facts: outcome.externalFacts },
      dedupeKey: `ecosystem-fact-propose:${revisionId}`,
    });
  }
}
