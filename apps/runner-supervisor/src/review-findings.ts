import { isHighRiskSeverity } from '@reviewbot/findings';
import { recordOccurrence, semanticFingerprint, setFindingLifecycle, upsertFinding } from '@reviewbot/finding-lifecycle';
import type { ProcessedFinding, ReviewOutcome } from '@reviewbot/review-orchestrator';
import { recordFinding } from '@reviewbot/telemetry';
import type { ReviewRevisionContext } from './review-revision.js';

/**
 * Occurrence `state`: a single human-readable string flattened from the internal publication axes,
 * with values kept verbatim from before the split so historical rows stay comparable.
 */
function occurrenceState(f: ProcessedFinding): string {
  if (f.suppressed) return 'suppressed';
  if (f.decision.status !== 'confirmed') {
    return isHighRiskSeverity(f.verdict.severity) ? 'unverified-risks' : 'low-evidence';
  }
  return f.placement === 'inline' ? 'inline' : 'summary';
}

/**
 * Writes `findings` after a review: fingerprint upsert (lifecycle across revisions) + this occurrence.
 * Data source for incremental review, `@winnowl fix`, auto-issue and checks.
 */
export function createReviewFindingsWriter(): (outcome: ReviewOutcome, ctx: ReviewRevisionContext) => Promise<void> {
  return async (outcome, ctx) => {
    for (const f of outcome.findings) {
      const fingerprint = semanticFingerprint({
        repositoryId: ctx.payload.repositoryId,
        category: f.category,
        claim: f.claim,
        codeWindow: f.primaryAnchorText,
        // Same inputs as review-side computeFingerprint, or stored fingerprints won't match this round's.
        ...(f.path ? { path: f.path } : {}),
      });
      const { id } = await upsertFinding(ctx.db, {
        tenantId: ctx.payload.tenantId,
        repositoryId: ctx.payload.repositoryId,
        fingerprint,
        category: f.category,
        canonicalClaim: f.claim,
        // Suppressed findings are still stored (audit trail, Console's suppressed page), but new rows are
        // `retracted`: outside ACTIVE_LIFECYCLES, so not in incremental reconciliation nor the gate.
        ...(f.suppressed ? { lifecycle: 'retracted' as const } : {}),
        // Cross-round match found an existing issue: continue on that row so a drifted fingerprint does not open a new one.
        ...(f.matchedFindingId ? { matchedFindingId: f.matchedFindingId } : {}),
      });
      // Publishing precedes storage, so publication_records.finding_id holds the candidate id; replace it with
      // the real id, or reply → finding lookups (ignore/challenge/feedback/fix) never join.
      await ctx.db
        .updateTable('publication_records')
        .set({ finding_id: id })
        .where('finding_id', '=', f.candidateId)
        .where('revision_id', '=', ctx.payload.revisionId)
        .execute();
      await recordOccurrence(ctx.db, {
        tenantId: ctx.payload.tenantId,
        findingId: id,
        revisionId: ctx.payload.revisionId,
        // Store the actual disposition: suppressed is always suppressed, regardless of the matrix route.
        state: occurrenceState(f),
        severity: f.verdict.severity,
        changeRelation: f.verdict.changeRelation,
        confirmation: f.verdict.confirmation,
        ...(f.anchor ? { anchor: f.anchor } : {}),
        // Persist the flagged code window + blocking flag for later gate reconciliation (window = focus of directed re-check).
        anchorText: f.primaryAnchorText,
        blocking: f.decision.blocking,
        // Downgrade reason chain, so "why is this collapsed" can be answered after the round.
        ...(f.demotions && f.demotions.length > 0 ? { demotions: f.demotions } : {}),
        ...(f.suppressReason ? { suppressReason: f.suppressReason } : {}),
        ...(f.codeContext ? { codeContext: f.codeContext } : {}),
        ...(f.suggestion ? { suggestion: f.suggestion } : {}),
        ...(f.verdict.effort ? { effort: f.verdict.effort } : {}),
        ...(f.refuterUpheld !== undefined ? { refuterUpheld: f.refuterUpheld } : {}),
        claim: f.claim,
        ...(f.verdict.rationale ? { rationale: f.verdict.rationale } : {}),
      });
      // Count published findings only; suppressed ones would inflate the review's output.
      if (!f.suppressed) recordFinding(f.verdict.severity, f.decision.blocking);
    }
    /*
     * Gate reconciliation: preexisting findings confirmed fixed → resolved. Prefer ids: after fingerprint
     * drift one issue may have several rows. Older outcomes only carry fingerprints, hence the fallback.
     */
    for (const id of outcome.resolvedFindingIds ?? []) {
      await setFindingLifecycle(ctx.db, id, 'resolved');
    }
    /*
     * Stale archival: not found for several rounds while its code changed → leave the active set. Unlike
     * resolved (a verdict), this is an inference and must be reversible (`upsertFinding` restores it).
     */
    for (const id of outcome.staleFindingIds ?? []) {
      await setFindingLifecycle(ctx.db, id, 'stale');
    }
    // TODO: remove the fingerprint fallback once every executor version reports resolvedFindingIds.
    if (!outcome.resolvedFindingIds) {
      for (const fp of outcome.resolvedFingerprints ?? []) {
        const row = await ctx.db
          .selectFrom('findings')
          .select('id')
          .where('repository_id', '=', ctx.payload.repositoryId)
          .where('semantic_fingerprint', '=', fp)
          .executeTakeFirst();
        if (row) await setFindingLifecycle(ctx.db, row.id, 'resolved');
      }
    }
  };
}
