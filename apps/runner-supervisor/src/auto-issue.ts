import { insertActionPlan, newActionPlan } from '@reviewbot/actions';
import { findOrCreateConversationByTarget } from '@reviewbot/conversation';
import { decideAutoIssues, type AutoIssueFinding } from '@reviewbot/issue-intelligence';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import { botName } from '@reviewbot/domain';
import type { ReviewRevisionContext } from './review-revision.js';
import { botMessages } from './locale.js';

/**
 * Proposes issues (confirmation required) for preexisting-unrelated findings when
 * `reviews.scope.auto_issue_preexisting` is on. Only newly seen findings are proposed, so recurring ones dedupe.
 */
export function createAutoIssueProposer(): (
  outcome: ReviewOutcome,
  ctx: ReviewRevisionContext,
) => Promise<void> {
  return async (outcome, ctx) => {
    const cfg = await loadEffectiveConfig(ctx.db, ctx.payload.tenantId, ctx.payload.repositoryId);
    if (!cfg.reviews.scope.auto_issue_preexisting) return;

    const eligible = outcome.findings.filter(
      (f): f is typeof f & { fingerprint: string } =>
        f.verdict.changeRelation === 'preexisting-unrelated' &&
        !f.suppressed &&
        f.incremental !== 'persisted' &&
        f.fingerprint !== undefined,
    );
    if (eligible.length === 0) return;

    const autoFindings: AutoIssueFinding[] = eligible.map((f) => ({
      findingId: f.fingerprint,
      fingerprint: f.fingerprint,
      title: f.claim.slice(0, 100),
      severity: f.verdict.severity,
      changeRelation: f.verdict.changeRelation,
      confirmation: f.verdict.confirmation,
      evidencePermalink: `#${ctx.changeRequest.number}`,
      evidenceSummary: f.claim,
    }));

    // Incremental state dedupes within a round; the action_plans.dedupe_key unique index dedupes across rounds and concurrency.
    const decision = decideAutoIssues(autoFindings, {
      config: {
        enabled: true,
        minSeverity: 'medium',
        minConfirmation: 'independently-verified',
        label: 'ai-found',
        maxPerReview: 5,
      },
      existingFingerprints: new Set<string>(),
    });
    if (decision.create.length === 0) return;

    const conversation = await findOrCreateConversationByTarget(ctx.db, {
      tenantId: ctx.payload.tenantId,
      target: { kind: 'change-request', nativeId: ctx.changeRequest.nativeId },
      repositoryId: ctx.payload.repositoryId,
      changeRequestId: ctx.payload.changeRequestId,
    });
    // The "Auto-filed by" footer is localized at publish time; the label matches decideAutoIssues.
    const footer = botMessages(cfg.language).autoIssue.footer({
      bot: botName(),
      label: 'ai-found',
    });
    for (const c of decision.create) {
      const plan = newActionPlan({
        conversationId: conversation.id,
        actorId: 'winnowl-auto-issue',
        approvalActor: 'any-authorized',
        dedupeKey: `auto-issue:${ctx.payload.repositoryId}:${c.findingId}`,
        actions: [{ type: 'create-issue', description: `${c.title}\n\n${c.body}\n\n${footer}` }],
        requiredPermissions: ['action:approve'],
      });
      try {
        await insertActionPlan(ctx.db, ctx.payload.tenantId, plan);
      } catch (error) {
        // The unique index serializes repeated/manual reviews. The competing proposal is equivalent.
        if ((error as { code?: string }).code !== '23505') throw error;
      }
    }
  };
}
