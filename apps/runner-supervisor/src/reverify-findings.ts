import type { ChangeRequestRef } from '@reviewbot/domain';
import {
  dismissFindingForChangeRequest,
  loadChangeRequestActiveFinding,
  loadChangeRequestBlockingFindings,
  setOccurrenceBlocking,
  type ChangeRequestBlockingFinding,
} from '@reviewbot/finding-lifecycle';
import { decidePublication, type FindingCategory, type Severity } from '@reviewbot/findings';
import type { DiscussionThread, SourceControlProvider } from '@reviewbot/provider-contracts';
import { reviewStandardsContext } from '@reviewbot/review-orchestrator';
import { loadEffectiveConfig, type ReviewEnv, type RuntimeCtx } from '@reviewbot/review-runtime';
import {
  verifyCandidateWithVotes,
  type VerifiableCandidate,
  type VerifiedCandidate,
  type VerifyDeps,
} from '@reviewbot/verification';
import { billRevision } from './learning-propose.js';
import { BADGE } from './badges.js';
import { botMessages } from './locale.js';
import { replyKey } from './reply-key.js';
import { addUsage, newUsage } from './propose-common.js';
import { recomputeReviewGate } from './review-checks.js';
import type { JobHandler } from './supervisor.js';

/** Directed reverify / challenge-finding: reruns only the Verifier/Refuter on published findings, not Map/Dig. */
export interface ReverifyFindingsPayload {
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
  revisionId: string;
  headSha: string;
  /** challenge: only this finding (blocking or not); omitted: every active blocking finding of the CR. */
  targetFindingId?: string;
  /** Requester login, for the @mention in the reply. */
  requesterLogin?: string;
  /** The author's reply in the finding thread (why no fix is needed), given to verifier / refuter as a claim to check. */
  authorReply?: string;
  /** Thread to answer in (path+line lookup picks the wrong thread when two findings share a line). */
  threadNativeId?: string;
}

export type ReverifyOutcome = 'uphold' | 'retract' | 'downgrade';

/**
 * reject → retract (the only retraction path); uncertain → uphold (conservative);
 * accept → downgrade if it was blocking and the Publication Matrix no longer blocks it, else uphold.
 */
export function classifyReverify(
  verified: VerifiedCandidate,
  category: FindingCategory,
  priorBlocking: boolean,
  /** Same gate criteria as review (`merge_gate.block_on_severity` / `reviews.block_preexisting`). */
  gate: { blockOnSeverity?: readonly Severity[]; blockPreexisting?: boolean } = {},
): ReverifyOutcome {
  const v = verified.verdict;
  if (v.decision === 'reject') return 'retract';
  if (v.decision === 'uncertain') return 'uphold';
  const stillBlocking = decidePublication({
    decision: 'accept',
    category,
    severity: v.severity,
    confirmation: v.confirmation,
    changeRelation: v.changeRelation,
    actionable: v.actionable,
    ...(verified.refuterUpheld !== undefined ? { refuterUpheld: verified.refuterUpheld } : {}),
    // Only whether it still blocks matters, not inline placement, so the anchor counts as usable.
    anchorUnique: true,
    anchorScore: 1,
    ...(gate.blockOnSeverity !== undefined ? { blockOnSeverity: gate.blockOnSeverity } : {}),
    ...(gate.blockPreexisting !== undefined ? { blockPreexisting: gate.blockPreexisting } : {}),
  }).blocking;
  if (priorBlocking && !stillBlocking) return 'downgrade';
  return 'uphold';
}

function rebuildCandidate(f: ChangeRequestBlockingFinding, authorReply?: string): VerifiableCandidate {
  return {
    id: f.id,
    claim: f.claim,
    category: f.category as FindingCategory,
    suspectedSeverity: f.severity as VerifiableCandidate['suspectedSeverity'],
    // Older rows may lack anchorText; the Verifier then locates it from path/claim and source tools.
    primaryAnchorText: f.anchorText ?? '',
    changeRelationHypothesis: 'introduced',
    ...(f.path ? { path: f.path } : {}),
    ...(authorReply ? { authorReply } : {}),
  };
}

const RATIONALE_MAX_CHARS = 1200;


/**
 * The rationale shown to the author: the refuter's when it overturned (the verifier had accepted),
 * otherwise the verifier's.
 */
export function reverifyRationale(verified: VerifiedCandidate): string | undefined {
  const text =
    verified.refutation?.decision === 'reject' && verified.refutation.arguments.length > 0
      ? verified.refutation.arguments.join(' ')
      : verified.verdict.rationale;
  const trimmed = text?.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, RATIONALE_MAX_CHARS) : undefined;
}

export interface ReverifyFindingsDeps {
  /** The review buildEnv (createReviewBuildEnv): current head worktree plus model/bundles/votes. */
  buildEnv: (ctx: RuntimeCtx) => Promise<ReviewEnv>;
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
  /** Cap on findings rechecked per run (cost); the rest keep their verdict. Default 20. */
  maxVerify?: number;
}

interface ReverifyResult {
  finding: ChangeRequestBlockingFinding;
  outcome: ReverifyOutcome;
  rationale?: string;
}

/** The bot's inline thread whose anchor matches the finding. */
export function findThread(
  threads: DiscussionThread[],
  f: Pick<ChangeRequestBlockingFinding, 'path' | 'line'>,
): DiscussionThread | undefined {
  if (!f.path) return undefined;
  return threads.find(
    (t) =>
      t.anchor?.path === f.path &&
      (f.line === undefined || t.anchor?.line === f.line) &&
      t.comments.some((c) => c.isBot),
  );
}

/**
 * reverify_findings handler. Replies per finding in its thread; retract also resolves the thread and records a
 * CR-level dismissal. Posts one summary comment; usage is billed to the triggering revision. Never deletes comments.
 */
export function createReverifyFindingsHandler(deps: ReverifyFindingsDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as ReverifyFindingsPayload;

    const cr = await db
      .selectFrom('change_requests')
      .select(['id', 'repository_id', 'native_id', 'number', 'kind'])
      .where('id', '=', payload.changeRequestId)
      .where('tenant_id', '=', payload.tenantId)
      .where('repository_id', '=', payload.repositoryId)
      .executeTakeFirst();
    if (!cr) return;

    const revision = await db
      .selectFrom('revisions')
      .select('id')
      .where('id', '=', payload.revisionId)
      .where('tenant_id', '=', payload.tenantId)
      .where('change_request_id', '=', cr.id)
      .where('head_sha', '=', payload.headSha)
      .executeTakeFirst();
    if (!revision) return;

    const provider = await deps.buildProvider(payload.repositoryId);
    const ref: ChangeRequestRef = {
      id: cr.id,
      repositoryId: cr.repository_id,
      nativeId: cr.native_id,
      number: cr.number,
      kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
    };
    const cfg = await loadEffectiveConfig(db, payload.tenantId, payload.repositoryId);
    const m = botMessages(cfg.language).reverify;

    // Active blocking findings of this CR (not the whole repo); a challenge targets the named finding, blocking or not.
    const active = await loadChangeRequestBlockingFindings(db, payload.changeRequestId, {
      blockPreexisting: cfg.reviews.block_preexisting,
      blockOnSeverity: cfg.merge_gate.block_on_severity,
    });
    const blockingIds = new Set(active.map((f) => f.id));
    const named = payload.targetFindingId
      ? await loadChangeRequestActiveFinding(db, payload.changeRequestId, payload.targetFindingId)
      : undefined;
    const targets = payload.targetFindingId ? (named ? [named] : []) : active;
    if (targets.length === 0) {
      await provider.discussions.createTopLevelComment(
        { kind: 'change-request', ref },
        { markdown: m.noTargets() },
        // Asking again (reworded) is a new request and must not be swallowed by the previous key.
        { key: `reverify:none:${cr.id}:${payload.headSha}${replyKey(payload.authorReply)}` },
      );
      return;
    }

    const env = await deps.buildEnv({
      payload: {
        revisionId: payload.revisionId,
        tenantId: payload.tenantId,
        repositoryId: payload.repositoryId,
      },
      db,
    });
    try {
      const verifyDeps: VerifyDeps = {
        source: env.source,
        model: env.model,
        streamFn: env.streamFn,
        bundles: { verifier: env.bundles.verifier, refuter: env.bundles.refuter },
        budget: env.budget,
        ...(env.pluginTools !== undefined ? { pluginTools: env.pluginTools } : {}),
        // Same review standards: findings about repository conventions need the conventions.
        standards: reviewStandardsContext({
          ...(env.knowledgeContext !== undefined ? { knowledgeContext: env.knowledgeContext } : {}),
          ...(env.repositoryGuidance !== undefined ? { repositoryGuidance: env.repositoryGuidance } : {}),
        }),
      };
      const votes = env.verifyVotes ?? 1;

      const maxVerify = deps.maxVerify ?? 20;
      const usage = newUsage();
      const results: ReverifyResult[] = [];
      for (const f of targets.slice(0, maxVerify)) {
        const verified = await verifyCandidateWithVotes(verifyDeps, rebuildCandidate(f, payload.authorReply), votes);
        addUsage(usage, verified.usage);
        const rationale = reverifyRationale(verified);
        results.push({
          finding: f,
          ...(rationale ? { rationale } : {}),
          outcome: classifyReverify(verified, f.category as FindingCategory, blockingIds.has(f.id), {
            blockOnSeverity: cfg.merge_gate.block_on_severity,
            blockPreexisting: cfg.reviews.block_preexisting,
          }),
        });
      }
      if (targets.length > maxVerify)
        log('reverify capped', { total: targets.length, verified: maxVerify });

      const threads = await provider.discussions.listThreads({ kind: 'change-request', ref });
      // Thread resolution needs provider support (GitHub via GraphQL); otherwise it is skipped.
      const caps = await provider.capabilities.forChangeRequest(ref);
      for (const r of results) {
        // Badges are added by the renderer, not the locale dictionary.
        const body =
          r.outcome === 'retract'
            ? m.retracted({ claim: r.finding.claim })
            : r.outcome === 'downgrade'
              ? m.downgraded({ claim: r.finding.claim })
              : m.upheld({ claim: r.finding.claim });
        // Show the author what we checked, not just the verdict.
        const line = `${BADGE.reverified} ${body}${r.rationale ? `\n\n> ${r.rationale}` : ''}`;
        const thread =
          (payload.threadNativeId ? threads.find((t) => t.ref.nativeId === payload.threadNativeId) : undefined) ??
          findThread(threads, r.finding);
        if (thread) {
          await provider.discussions.reply(
            thread.ref,
            { markdown: line },
            { key: `reverify:${r.finding.id}:${payload.headSha}${replyKey(payload.authorReply)}` },
          );
          if (r.outcome === 'retract' && caps.resolvableThreads && provider.discussions.resolve)
            await provider.discussions.resolve(thread.ref);
        }
        /*
         * Downgrade and retract must leave different traces:
         * - downgrade flips only this occurrence's blocking; the finding stays active and recurs next round.
         * - retract also adds a CR-level dismissal. Finding identity is repo-wide, so `lifecycle='retracted'` would
         *   mute it on other PRs, and flipping blocking alone would let it come back next round. The dismissal
         *   stores a weak fingerprint, so it survives the claim being reworded.
         */
        if (r.outcome === 'retract' || r.outcome === 'downgrade')
          await setOccurrenceBlocking(db, r.finding.id, r.finding.revisionId, false);
        if (r.outcome === 'retract')
          await dismissFindingForChangeRequest(db, {
            tenantId: payload.tenantId,
            findingId: r.finding.id,
            changeRequestId: payload.changeRequestId,
            actor: 'winnowl-reverify',
          });
      }

      const counts = {
        upheld: results.filter((r) => r.outcome === 'uphold').length,
        retracted: results.filter((r) => r.outcome === 'retract').length,
        downgraded: results.filter((r) => r.outcome === 'downgrade').length,
      };
      const summary = `${BADGE.reverified} ${m.summary(counts)}`;
      await provider.discussions.createTopLevelComment(
        { kind: 'change-request', ref },
        { markdown: summary },
        { key: `reverify:${payload.targetFindingId ?? 'all'}:${cr.id}:${payload.headSha}${replyKey(payload.authorReply)}` },
      );

      await billRevision(db, payload.revisionId, usage);

      // Recompute the check run now when the blocking set changed; approve only with zero blocking and an
      // unmoved head (see recomputeReviewGate). uphold-only leaves the gate alone.
      if (counts.retracted + counts.downgraded > 0) {
        await recomputeReviewGate(
          { db, buildProvider: deps.buildProvider },
          {
            tenantId: payload.tenantId,
            repositoryId: payload.repositoryId,
            changeRequestId: cr.id,
            headSha: payload.headSha,
            crRef: ref,
            autoApprove: cfg.reviews.auto_approve,
          },
        );
      }
      log('reverify_findings done', { changeRequestId: cr.id, ...counts });
    } finally {
      await env
        .disposeWorkspace()
        .catch((error) =>
          log('reverify workspace cleanup failed', { error: (error as Error)?.message }),
        );
    }
  };
}
