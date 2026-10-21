import {
  confirmActionPlan,
  evaluatePolicy,
  listActionPlans,
  insertActionPlan,
  newActionPlan,
  type ActionPlan,
  type ActionRepoPolicy,
  type ApprovalProvenance,
  type PlannedAction,
} from '@reviewbot/actions';
import {
  COMMANDS,
  commandUsage,
  updateConversation,
  type Conversation,
  type ParsedIntent,
} from '@reviewbot/conversation';
import { detectInjectionAttempt } from '@reviewbot/agent-pi';
import { botMention, botName } from '@reviewbot/domain';
import { stringify as stringifyYaml } from 'yaml';
import {
  dismissFindingForChangeRequest,
  loadChangeRequestBlockingFindings,
  loadDismissedFindingIds,
  undismissFinding,
} from '@reviewbot/finding-lifecycle';
import { insertFeedback, isFeedbackClass, maybeAutoProposeLearning } from '@reviewbot/knowledge';
import type { RepositoryPermission } from '@reviewbot/provider-contracts';
import { uuidv7 } from '@reviewbot/ids';
import {
  cancelReviewJobsForChangeRequest,
  enqueueJob,
  REVIEW_JOB_MAX_ATTEMPTS,
  reviewDedupeKey,
  supersedeOlderReviewJobs,
} from '@reviewbot/queue';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import type { EffectiveRepositoryConfig } from '@reviewbot/config';
import { approveLearningFromComment, matchesIdFragment, proposeLearningFromComment } from './conversation-learning.js';
import { resolveFeedbackTarget } from './feedback-target.js';
import { replyKey } from './reply-key.js';
import { REVIEW_MANAGE_PERMISSIONS, type ActorPermissionResolver } from './review-permissions.js';
import type { createStatusComment } from './status-comment.js';
import type { TranslationFunctions } from './i18n/i18n-types.js';
import { botMessages } from './locale.js';
import { JobExecutionError, type JobHandlerDb } from './supervisor.js';
import type {
  ConversationReply,
  ConversationRouteContext,
  ConversationTurnPayload,
} from './conversation-turn.js';

type ConversationText = TranslationFunctions['conversation'];

export type { ActorPermissionResolver };

/** Fetches the CR author from the provider, to backfill rows stored without one. */
export type ChangeRequestAuthorResolver = (
  repositoryId: string,
  changeRequestId: string,
) => Promise<{ login: string; providerUserId?: string } | null>;

function acknowledgement(intent: ParsedIntent, m: ConversationText): string {
  switch (intent.intent) {
    case 'explain-finding':
      return m.explainPreparing();
    case 'challenge-finding':
    case 'reverify':
      return m.reverifyAck();
    case 'fix-finding':
    case 'fix-all':
      return m.fixAck();
    case 'resolve-finding':
      return m.resolveAck();
    default:
      return m.commandNotApplicable({ intent: intent.intent, bot: botMention() });
  }
}

/** Every command with its localized summary, from the shared catalog. */
function helpText(m: ConversationText): string {
  const help = m.help as unknown as Record<string, () => string>;
  const lines = COMMANDS.map((c) => `- \`${commandUsage(botName(), c)}\` — ${help[c.key]?.() ?? c.summary}`);
  return [m.helpHeader({ bot: botMention() }), '', ...lines].join('\n');
}

function proposalMessage(plan: ActionPlan, m: ConversationText): string {
  const summary = plan.actions.map((a) => `\`${a.type}\` — ${a.description}`).join('\n- ');
  return [m.proposalHeader(), `- ${summary}`, '', m.proposalFooter({ planId: plan.id, bot: botMention() })].join('\n');
}

/** Finishing-action intent → FixPlan.kind. */
const FINISHING_KIND: Record<string, string> = {
  'generate-tests': 'generate-tests',
  'generate-docs': 'generate-docs',
  'generate-diagram': 'generate-diagram',
  simplify: 'simplify',
  'resolve-conflict': 'resolve-conflict',
  'add-comments': 'add-comments',
};

/** Strips trailing punctuation since the claim is embedded mid-sentence in replies. */
function trimClaim(claim: string): string {
  return claim.trim().replace(/[。.!!??；;,,]+$/u, '');
}

/**
 * Whether the commenter may run review-managing commands on this CR. Anyone can comment on a
 * public repo, so only the CR author (matched by stable provider id, else login) or users with
 * write access and above are allowed. A failed permission lookup counts as no permission.
 */
async function canManageReviews(
  db: JobHandlerDb,
  deps: {
    resolveActorPermission?: ActorPermissionResolver;
    resolveChangeRequestAuthor?: ChangeRequestAuthorResolver;
  },
  changeRequestId: string,
  payload: ConversationTurnPayload,
): Promise<boolean> {
  const cr = await db
    .selectFrom('change_requests')
    .select(['author', 'author_provider_id'])
    .where('id', '=', changeRequestId)
    .executeTakeFirst();
  if (!cr) return false;
  let author: { login: string | null; providerUserId: string | null } = {
    login: cr.author,
    providerUserId: cr.author_provider_id,
  };
  // Older rows have no author; backfill lazily so fork contributors are not locked out of their own PR.
  if (
    author.login === null &&
    author.providerUserId === null &&
    deps.resolveChangeRequestAuthor &&
    payload.repositoryId
  ) {
    const fetched = await deps.resolveChangeRequestAuthor(payload.repositoryId, changeRequestId);
    if (fetched) {
      await db
        .updateTable('change_requests')
        .set({ author: fetched.login, author_provider_id: fetched.providerUserId ?? null })
        .where('id', '=', changeRequestId)
        .execute();
      author = { login: fetched.login, providerUserId: fetched.providerUserId ?? null };
    }
  }
  const isAuthor =
    author.providerUserId && payload.actorId
      ? author.providerUserId === payload.actorId
      : author.login !== null && author.login === payload.actorLogin;
  if (isAuthor) return true;
  if (!deps.resolveActorPermission || !payload.repositoryId) return false;
  const permission = await deps.resolveActorPermission(payload.repositoryId, {
    login: payload.actorLogin,
    ...(payload.actorId ? { providerUserId: payload.actorId } : {}),
  });
  return REVIEW_MANAGE_PERMISSIONS.has(permission);
}

/** Repository-level write check for commands without a CR (e.g. on issues); lookup failure = denied. */
async function canWriteRepository(
  deps: { resolveActorPermission?: ActorPermissionResolver },
  payload: ConversationTurnPayload,
): Promise<boolean> {
  if (!deps.resolveActorPermission || !payload.repositoryId) return false;
  const permission = await deps
    .resolveActorPermission(payload.repositoryId, {
      login: payload.actorLogin,
      ...(payload.actorId ? { providerUserId: payload.actorId } : {}),
    })
    .catch(() => 'none' as RepositoryPermission);
  return REVIEW_MANAGE_PERMISSIONS.has(permission);
}

/**
 * Provider actor → linked platform user, or undefined. Never creates a user: only existing
 * platform users have their personal credentials used.
 */
async function resolveActorUserId(
  db: JobHandlerDb,
  repositoryId: string,
  actorId: string | undefined,
): Promise<string | undefined> {
  if (!actorId) return undefined;
  const host = await db
    .selectFrom('repositories')
    .innerJoin('provider_hosts', 'provider_hosts.id', 'repositories.provider_host_id')
    .select('provider_hosts.base_url as issuer')
    .where('repositories.id', '=', repositoryId)
    .executeTakeFirst();
  if (!host) return undefined;
  const identity = await db
    .selectFrom('user_identities')
    .select('user_id')
    .where('kind', '=', 'provider')
    .where('issuer', '=', host.issuer)
    .where('subject', '=', actorId)
    .executeTakeFirst();
  return identity?.user_id;
}

/**
 * Proposes a branch-write action plan. Pre-authorized repos get an `approved` plan whose
 * action_execute job is enqueued in the same transaction, so an approved plan never lacks a job.
 */
async function proposeBranchWriteAction(input: {
  db: JobHandlerDb;
  payload: ConversationTurnPayload;
  conversation: Conversation;
  cfg: EffectiveRepositoryConfig;
  actions: PlannedAction[];
  revisionSha?: string;
  m: ConversationText;
  reply?: ConversationReply;
  now?: number;
}): Promise<void> {
  const { db, payload, cfg, m, now } = input;
  if (!cfg.actions.autofix.delivery.includes('stacked-change-request')) {
    if (input.reply) await input.reply(payload, m.stackedDeliveryDisabled());
    return;
  }
  const repoPolicy: ActionRepoPolicy = {
    autofix: {
      enabled: cfg.actions.autofix.enabled,
      requireConfirmation: cfg.actions.autofix.require_confirmation,
    },
  };
  const requiresConfirmation = input.actions.some(
    (a) =>
      evaluatePolicy({ action: a.type, actorIsRepoAdmin: false, repoPolicy }).requiresConfirmation,
  );
  const plan = newActionPlan({
    conversationId: input.conversation.id,
    actorId: payload.actorId ?? payload.actorLogin,
    ...(input.revisionSha !== undefined ? { revisionSha: input.revisionSha } : {}),
    actions: input.actions,
    requiredPermissions: requiresConfirmation ? ['action:approve'] : [],
    ...(now !== undefined ? { now } : {}),
  });

  if (requiresConfirmation) {
    await insertActionPlan(db, payload.tenantId, plan, now);
    await updateConversation(db, input.conversation.id, { state: 'waiting-confirmation' }, now);
    if (input.reply) await input.reply(payload, proposalMessage(plan, m));
    return;
  }

  await db.transaction().execute(async (trx) => {
    await insertActionPlan(trx, payload.tenantId, { ...plan, status: 'approved' }, now);
    await enqueueJob(trx, {
      tenantId: payload.tenantId,
      type: 'action_execute',
      payload: { tenantId: payload.tenantId, planId: plan.id },
      dedupeKey: `action-execute:${plan.id}`,
    });
  });
  await updateConversation(db, input.conversation.id, { state: 'active' }, now);
  if (input.reply) await input.reply(payload, m.autoApproved({ planId: plan.id }));
}

/**
 * `@bot approve [plan]`: the same confirmation as the console (requester, unmoved head, repo
 * policy), with execution queued in the same transaction. The argument is a plan id prefix
 * (>= 6 chars); without it, the commenter's newest pending plan in this conversation.
 */
async function approvePlanFromComment(input: {
  db: JobHandlerDb;
  deps: { resolveActorPermission?: ActorPermissionResolver; resolveChangeRequestAuthor?: ChangeRequestAuthorResolver; reply?: ConversationReply };
  payload: ConversationTurnPayload;
  conversation: Conversation;
  cfg: EffectiveRepositoryConfig | undefined;
  m: ConversationText;
  argument?: string;
  now?: number;
}): Promise<void> {
  const { db, deps, payload, m } = input;
  const reply = (text: string) => (deps.reply ? deps.reply(payload, text) : Promise.resolve());
  const now = input.now ?? Date.now();
  // No login fallback: execution re-verifies this id with the provider, and logins can be renamed.
  const actor = payload.actorId;
  const wanted = input.argument?.trim().replace(/^`|`$/g, '').toLowerCase();
  if (wanted && wanted.length < 6) return void (await reply(m.approveIdTooShort({ bot: botMention() })));
  const pending = (await listActionPlans(db, payload.tenantId, 50, input.conversation.id)).filter(
    (p) => p.status === 'proposed' && p.expiresAt > now,
  );
  // Without an actor id, skip filtering so the refusal below can name a real plan.
  const mine = actor
    ? pending.filter((p) => p.approvalActor === 'any-authorized' || p.actorId === actor)
    : pending;
  const matched = wanted ? pending.filter((p) => matchesIdFragment(p.id, wanted)) : [];
  // Ids are uuidv7: plans created close together share a long prefix, so a fragment must pick exactly one.
  if (matched.length > 1) return void (await reply(m.approveIdAmbiguous({ bot: botMention() })));
  const plan = wanted ? matched[0] : mine[0];
  if (!plan) {
    return void (await reply(pending.length > 0 && !wanted ? m.approveNotYours() : m.approveNothingPending({ bot: botMention() })));
  }
  // Who may approve a branch write here: who may ask for one (PR author, write access and above).
  if (!payload.changeRequestId || !(await canManageReviews(db, deps, payload.changeRequestId, payload).catch(() => false))) {
    return void (await reply(m.authorOnly()));
  }
  if (!actor) {
    return void (await reply(
      m.approveRefused({ planId: plan.id, reason: 'your forge account id is missing from this event' }),
    ));
  }
  // Execution re-verifies the approval against this forge host.
  const hostRow = payload.repositoryId
    ? await db
        .selectFrom('repositories')
        .innerJoin('provider_hosts', 'provider_hosts.id', 'repositories.provider_host_id')
        .select('provider_hosts.base_url')
        .where('repositories.id', '=', payload.repositoryId)
        .where('repositories.tenant_id', '=', payload.tenantId)
        .executeTakeFirst()
    : undefined;
  if (!hostRow) {
    return void (await reply(
      m.approveRefused({ planId: plan.id, reason: 'the repository host could not be resolved' }),
    ));
  }
  const approval: ApprovalProvenance = {
    source: 'provider-comment',
    actorId: actor,
    login: payload.actorLogin,
    host: hostRow.base_url,
  };
  const cfg = input.cfg;
  const repoPolicy: ActionRepoPolicy = {
    autofix: {
      enabled: cfg?.actions.autofix.enabled ?? true,
      requireConfirmation: cfg?.actions.autofix.require_confirmation ?? true,
    },
    createIssue: {
      enabled: cfg?.actions.create_issue.enabled ?? true,
      requireConfirmation: cfg?.actions.create_issue.require_confirmation ?? true,
    },
    mergeGovernanceEnabled: cfg?.merge_gate.enabled ?? false,
  };
  const repoAllows = plan.actions.every((a) => evaluatePolicy({ action: a.type, actorIsRepoAdmin: true, repoPolicy }).allowed);
  const head = await db
    .selectFrom('revisions')
    .select('head_sha')
    .where('tenant_id', '=', payload.tenantId)
    .where('change_request_id', '=', payload.changeRequestId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  const result = await db.transaction().execute(async (trx) => {
    const r = await confirmActionPlan(
      trx,
      payload.tenantId,
      {
        planId: plan.id,
        actorId: actor,
        conversationId: input.conversation.id,
        ...(head ? { currentHeadSha: head.head_sha } : {}),
        now,
      },
      { repoAllows, actorPermissions: ['action:approve'], approval },
    );
    if (r.ok) {
      await enqueueJob(trx, {
        tenantId: payload.tenantId,
        type: 'action_execute',
        payload: { tenantId: payload.tenantId, planId: plan.id },
        dedupeKey: `action-execute:${plan.id}`,
      });
    }
    return r;
  });
  if (!result.ok) return void (await reply(m.approveRefused({ planId: plan.id, reason: result.reason ?? 'refused' })));
  await updateConversation(db, input.conversation.id, { state: 'active' }, now);
  await reply(m.planApproved({ planId: plan.id, actions: plan.actions.map((a) => a.type).join(', ') }));
}

/**
 * Pausing also cancels the in-flight review (users usually pause after seeing one start);
 * returns the number of cancelled jobs. Resuming only flips the flag and does not start a review.
 */
async function setAutoReviewPaused(
  db: ConversationRouteContext['db'],
  tenantId: string,
  changeRequestId: string,
  paused: boolean,
  now: number,
): Promise<number> {
  await db
    .updateTable('change_requests')
    .set({ auto_review_paused: paused, updated_at: new Date(now) })
    .where('id', '=', changeRequestId)
    .where('tenant_id', '=', tenantId)
    .execute();
  return paused ? await cancelReviewJobsForChangeRequest(db, tenantId, changeRequestId) : 0;
}

/** Intent router. Write actions are never triggered by classifier output alone. */
export function createConversationRoute(
  deps: {
    reply?: ConversationReply;
    now?: () => number;
    /**
     * Recomputes the merge gate immediately after `ignore`; otherwise it waits for the next review.
     * Injected rather than imported to avoid a module cycle with review-checks.
     */
    recomputeGate?: (input: {
      tenantId: string;
      repositoryId: string;
      changeRequestId: string;
    }) => Promise<void>;
    /** Omitted or failing → only the CR author may use review-managing commands. */
    resolveActorPermission?: ActorPermissionResolver;
    resolveChangeRequestAuthor?: ChangeRequestAuthorResolver;
    statusComment?: Pick<ReturnType<typeof createStatusComment>, 'requested' | 'denied'>;
  } = {},
): (ctx: ConversationRouteContext) => Promise<void> {
  return async ({ intent, conversation, payload, db }) => {
    if (
      (payload.repositoryId &&
        conversation.repositoryId &&
        conversation.repositoryId !== payload.repositoryId) ||
      (payload.changeRequestId &&
        conversation.changeRequestId &&
        conversation.changeRequestId !== payload.changeRequestId)
    ) {
      throw new JobExecutionError(
        'conversation target binding does not match the current repository/change request',
        'configuration_invalid',
        false,
      );
    }
    if (payload.repositoryId && payload.changeRequestId) {
      const binding = await db
        .selectFrom('change_requests')
        .select('id')
        .where('id', '=', payload.changeRequestId)
        .where('tenant_id', '=', payload.tenantId)
        .where('repository_id', '=', payload.repositoryId)
        .executeTakeFirst();
      if (!binding) {
        throw new JobExecutionError(
          'conversation repository/change-request binding is invalid',
          'configuration_invalid',
          false,
        );
      }
    }
    const cfg = payload.repositoryId
      ? await loadEffectiveConfig(db, payload.tenantId, payload.repositoryId)
      : undefined;
    const m = botMessages(cfg?.language).conversation;
    const reply = (text: string) => (deps.reply ? deps.reply(payload, text) : Promise.resolve());
    if (intent.intent === 'help') return void (await reply(helpText(m)));
    if (intent.intent === 'show-config') {
      if (!cfg) return;
      return void (await reply(m.showConfig({ yaml: stringifyYaml(cfg).trimEnd() })));
    }
    if (intent.intent === 'run-command') {
      if (!cfg?.chat.allow_run_command) return void (await reply(m.runDisabled()));
      const command = intent.argument?.trim();
      if (!payload.repositoryId || !payload.changeRequestId) return void (await reply(m.runNeedsPullRequest()));
      if (!command) return void (await reply(m.runUsage({ bot: botMention() })));
      // Runs the branch's code on our sandboxes: write access and above only. Authorship is not enough, since
      // anyone can open a pull request on a public repository.
      if (!(await canWriteRepository(deps, payload))) {
        return void (await reply(m.runNotAllowed()));
      }
      await enqueueJob(db, {
        tenantId: payload.tenantId,
        type: 'run_command',
        payload: { turn: payload, command },
        dedupeKey: `run-command:${payload.commentNativeId ?? payload.turnId ?? command}`,
      });
      return;
    }
    const isReviewIntent = intent.intent === 'review' || intent.intent === 'full-review';
    if (isReviewIntent) {
      if (!payload.repositoryId || !payload.changeRequestId) return;
      const statusTarget = {
        tenantId: payload.tenantId,
        repositoryId: payload.repositoryId,
        changeRequestId: payload.changeRequestId,
      };
      // Manual reviews bypass cost gates, so they are restricted like ignore/pause; the checkbox
      // path is checked too rather than trusting forge UI permissions.
      const allowed = await canManageReviews(db, deps, payload.changeRequestId, payload).catch(() => false);
      if (!allowed) {
        if (payload.command?.kind === 'review-checkbox') {
          await deps.statusComment?.denied(statusTarget, payload.actorLogin);
        } else if (deps.reply) {
          await deps.reply(payload, m.authorOnly());
        }
        return;
      }
      const crState = await db
        .selectFrom('change_requests')
        .select(['state', 'kind'])
        .where('id', '=', payload.changeRequestId)
        .where('tenant_id', '=', payload.tenantId)
        .where('repository_id', '=', payload.repositoryId)
        .executeTakeFirst();
      if (crState && crState.state !== 'open') {
        if (deps.reply) {
          await deps.reply(
            payload,
            m.changeRequestClosed({
              kind: crState.kind === 'merge-request' ? 'MR' : 'PR',
              state: crState.state,
            }),
          );
        }
        return;
      }
      const rev = await db
        .selectFrom('revisions')
        .select(['id', 'head_sha'])
        .where('change_request_id', '=', payload.changeRequestId)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (!rev) return;
      await supersedeOlderReviewJobs(db, {
        tenantId: payload.tenantId,
        changeRequestId: payload.changeRequestId,
        headSha: rev.head_sha,
      });
      const initiatedByUserId = await resolveActorUserId(db, payload.repositoryId, payload.actorId);
      await enqueueJob(db, {
        tenantId: payload.tenantId,
        type: 'review_revision',
        payload: {
          tenantId: payload.tenantId,
          repositoryId: payload.repositoryId,
          changeRequestId: payload.changeRequestId,
          revisionId: rev.id,
          headSha: rev.head_sha,
          configDigest: '',
          trigger: 'manual',
          ...(intent.intent === 'full-review' ? { forceFullReview: true } : {}),
          ...(initiatedByUserId ? { initiatedByUserId } : {}),
        },
        dedupeKey:
          reviewDedupeKey({
            repositoryId: payload.repositoryId,
            changeRequestId: payload.changeRequestId,
            headSha: rev.head_sha,
            configDigest: '',
          }) + (intent.intent === 'full-review' ? ':manual:full' : ':manual'),
        maxAttempts: REVIEW_JOB_MAX_ATTEMPTS,
      });
      if (payload.command?.kind === 'review-checkbox') {
        await deps.statusComment?.requested(statusTarget, payload.actorLogin);
      }
      return;
    }

    // Reverify reruns only verification on published findings, not exploration.
    if (
      (intent.intent === 'reverify' ||
        intent.intent === 'challenge-finding' ||
        // "Already fixed" is also reverified: a claim that no longer holds is retracted and resolved.
        intent.intent === 'resolve-finding') &&
      payload.repositoryId &&
      payload.changeRequestId
    ) {
      // Reverify can retract gate findings and costs money: same check as review.
      if (!(await canManageReviews(db, deps, payload.changeRequestId, payload).catch(() => false))) {
        if (deps.reply) await deps.reply(payload, m.authorOnly());
        return;
      }
      const rev = await db
        .selectFrom('revisions')
        .select(['id', 'head_sha'])
        .where('change_request_id', '=', payload.changeRequestId)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (!rev) return;
      // The author's argument, passed to verifier/refuter as a claim to check.
      const authorReply =
        intent.intent === 'reverify'
          ? undefined
          : intent.argument?.trim() || undefined;
      // Unresolvable target → reverify all active blocking findings.
      const targetFindingId =
        intent.intent === 'challenge-finding' || intent.intent === 'resolve-finding'
          ? (
              await resolveFeedbackTarget(db, {
                tenantId: payload.tenantId,
                repositoryId: payload.repositoryId,
                changeRequestId: payload.changeRequestId,
                nativeId: payload.target.nativeId,
              })
            )?.findingId
          : undefined;
      await enqueueJob(db, {
        tenantId: payload.tenantId,
        type: 'reverify_findings',
        payload: {
          tenantId: payload.tenantId,
          repositoryId: payload.repositoryId,
          changeRequestId: payload.changeRequestId,
          revisionId: rev.id,
          headSha: rev.head_sha,
          ...(targetFindingId ? { targetFindingId } : {}),
          ...(payload.actorLogin ? { requesterLogin: payload.actorLogin } : {}),
          ...(authorReply ? { authorReply } : {}),
          ...(payload.target.kind === 'review-thread' ? { threadNativeId: payload.target.nativeId } : {}),
        },
        dedupeKey: `reverify:${payload.changeRequestId}:${rev.head_sha}:${targetFindingId ?? 'all'}${replyKey(authorReply)}`,
      });
      if (deps.reply) await deps.reply(payload, m.reverifyTriggered());
      return;
    }

    // Dismissals are scoped to this CR, not the repository. They exclude the finding from the gate,
    // later publication and fix targets; distinct from retracted (false positive) and resolved.
    if (
      (intent.intent === 'ignore-finding' ||
        intent.intent === 'unignore-finding' ||
        intent.intent === 'ignore-pr') &&
      payload.repositoryId &&
      payload.changeRequestId
    ) {
      if (!(await canManageReviews(db, deps, payload.changeRequestId, payload))) {
        if (deps.reply) await deps.reply(payload, m.authorOnly());
        return;
      }
      const now = deps.now?.();
      // A top-level ignore/unignore applies to the whole PR and shares the pause flag.
      const prScope = intent.intent === 'ignore-pr' || payload.target.kind !== 'review-thread';
      if (prScope) {
        const paused = intent.intent !== 'unignore-finding';
        const stopped = await setAutoReviewPaused(
          db,
          payload.tenantId,
          payload.changeRequestId,
          paused,
          now ?? Date.now(),
        );
        if (deps.reply) {
          await deps.reply(
            payload,
            paused
              ? m.ignoredPr({ bot: botMention() }) + (stopped > 0 ? ` ${m.stoppedInFlight()}` : '')
              : m.resumed(),
          );
        }
        return;
      }
      // Inline: never guess when the replied-to comment is not a finding.
      const target = await resolveFeedbackTarget(db, {
        tenantId: payload.tenantId,
        repositoryId: payload.repositoryId,
        changeRequestId: payload.changeRequestId,
        nativeId: payload.target.nativeId,
      });
      if (!target) {
        if (deps.reply) await deps.reply(payload, m.ignoreNoTarget({ bot: botMention() }));
        return;
      }
      if (intent.intent === 'unignore-finding') {
        const removed = await undismissFinding(db, target.findingId, payload.changeRequestId);
        if (removed) {
          await deps.recomputeGate?.({
            tenantId: payload.tenantId,
            repositoryId: payload.repositoryId,
            changeRequestId: payload.changeRequestId,
          });
        }
        if (deps.reply)
          await deps.reply(
            payload,
            removed ? m.unignored({ claim: trimClaim(target.claim) }) : m.unignoreNotIgnored(),
          );
        return;
      }
      await dismissFindingForChangeRequest(db, {
        tenantId: payload.tenantId,
        findingId: target.findingId,
        changeRequestId: payload.changeRequestId,
        actor: payload.actorId ?? payload.actorLogin,
        ...(now !== undefined ? { now } : {}),
      });
      // Also recorded as feedback, which can feed learning proposals.
      await insertFeedback(
        db,
        payload.tenantId,
        {
          repositoryId: payload.repositoryId,
          class: 'not-important',
          actor: payload.actorLogin,
          fingerprint: target.fingerprint,
          findingId: target.findingId,
        },
        now,
      );
      await deps.recomputeGate?.({
        tenantId: payload.tenantId,
        repositoryId: payload.repositoryId,
        changeRequestId: payload.changeRequestId,
      });
      if (deps.reply)
        await deps.reply(payload, m.ignored({ claim: trimClaim(target.claim), bot: botMention() }));
      return;
    }

    if (intent.intent === 'approve-plan') {
      await approvePlanFromComment({
        db,
        deps,
        payload,
        conversation,
        cfg,
        m,
        ...(intent.argument ? { argument: intent.argument } : {}),
        ...(deps.now ? { now: deps.now() } : {}),
      });
      return;
    }

    // Per-CR auto-review switch; manual `@bot review` bypasses it without clearing it.
    if (
      (intent.intent === 'pause-reviews' || intent.intent === 'resume-reviews') &&
      payload.changeRequestId
    ) {
      if (!(await canManageReviews(db, deps, payload.changeRequestId, payload))) {
        if (deps.reply) await deps.reply(payload, m.authorOnly());
        return;
      }
      const paused = intent.intent === 'pause-reviews';
      const stopped = await setAutoReviewPaused(
        db,
        payload.tenantId,
        payload.changeRequestId,
        paused,
        deps.now?.() ?? Date.now(),
      );
      if (deps.reply) {
        await deps.reply(
          payload,
          paused
            ? m.paused({ bot: botMention() }) + (stopped > 0 ? ` ${m.stoppedInFlight()}` : '')
            : m.resumed(),
        );
      }
      return;
    }

    if (
      intent.intent === 'plan-issue' &&
      payload.target.kind === 'issue' &&
      payload.repositoryId &&
      payload.issueNumber !== undefined
    ) {
      await enqueueJob(db, {
        tenantId: payload.tenantId,
        type: 'issue_enrich',
        payload: {
          tenantId: payload.tenantId,
          repositoryId: payload.repositoryId,
          issueNativeId: payload.target.nativeId,
          issueNumber: payload.issueNumber,
          mode: 'plan',
        },
        dedupeKey: `issue-plan:${payload.repositoryId}:${payload.issueNumber}`,
      });
      return;
    }

    // `fix` targets the replied-to finding (else this CR's blocking findings); `fix all` targets this
    // CR's blocking findings. Dismissed findings are excluded. Bound to the head SHA the patch is based on.
    if (
      (intent.intent === 'fix-finding' || intent.intent === 'fix-all') &&
      payload.repositoryId &&
      payload.changeRequestId
    ) {
      const now = deps.now?.();
      // Fixes write branches (without confirmation in pre-authorized repos): author or write access only.
      if (!(await canManageReviews(db, deps, payload.changeRequestId, payload).catch(() => false))) {
        if (deps.reply) await deps.reply(payload, m.authorOnly());
        return;
      }
      if (!cfg!.actions.autofix.enabled) {
        if (deps.reply) await deps.reply(payload, m.autofixDisabled());
        return;
      }
      const dismissed = await loadDismissedFindingIds(db, payload.changeRequestId);
      const target =
        intent.intent === 'fix-finding'
          ? await resolveFeedbackTarget(db, {
              tenantId: payload.tenantId,
              repositoryId: payload.repositoryId,
              changeRequestId: payload.changeRequestId,
              nativeId: payload.target.nativeId,
            })
          : null;
      // Same blocking scope as the merge gate.
      const crFindings = (
        await loadChangeRequestBlockingFindings(db, payload.changeRequestId, {
          blockPreexisting: cfg!.reviews.block_preexisting,
          blockOnSeverity: cfg!.merge_gate.block_on_severity,
        })
      ).map((f) => ({ id: f.id }));
      const findings = (target ? [{ id: target.findingId }] : crFindings).filter(
        (f) => !dismissed.has(f.id),
      );
      if (findings.length === 0) {
        if (deps.reply) await deps.reply(payload, m.noActiveFindings());
        return;
      }
      const rev = await db
        .selectFrom('revisions')
        .select(['head_sha'])
        .where('change_request_id', '=', payload.changeRequestId)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      const description =
        (intent.argument ?? 'Fix referenced findings').trim() || 'Fix referenced findings';
      await proposeBranchWriteAction({
        db,
        payload,
        conversation,
        cfg: cfg!,
        actions: [
          { type: 'create-stacked-pr', description, findingIds: findings.map((f) => f.id) },
        ],
        ...(rev ? { revisionSha: rev.head_sha } : {}),
        m,
        ...(deps.reply ? { reply: deps.reply } : {}),
        ...(now !== undefined ? { now } : {}),
      });
      return;
    }

    // Finishing actions are branch writes on this change and share the autofix switch and confirmation.
    const finishingKind = FINISHING_KIND[intent.intent];
    if (finishingKind && payload.repositoryId && payload.changeRequestId) {
      const now = deps.now?.();
      if (!(await canManageReviews(db, deps, payload.changeRequestId, payload).catch(() => false))) {
        if (deps.reply) await deps.reply(payload, m.authorOnly());
        return;
      }
      if (!cfg!.actions.autofix.enabled) {
        if (deps.reply) await deps.reply(payload, m.finishingDisabled());
        return;
      }
      const rev = await db
        .selectFrom('revisions')
        .select(['head_sha'])
        .where('change_request_id', '=', payload.changeRequestId)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      const description = (intent.argument ?? finishingKind).trim() || finishingKind;
      await proposeBranchWriteAction({
        db,
        payload,
        conversation,
        cfg: cfg!,
        actions: [{ type: 'create-stacked-pr', description, fixKind: finishingKind }],
        ...(rev ? { revisionSha: rev.head_sha } : {}),
        m,
        ...(deps.reply ? { reply: deps.reply } : {}),
        ...(now !== undefined ? { now } : {}),
      });
      return;
    }

    if (intent.intent === 'create-issue' && payload.repositoryId && payload.changeRequestId) {
      // With require_confirmation=false nothing checks permissions at execution, so check here.
      if (!(await canManageReviews(db, deps, payload.changeRequestId, payload).catch(() => false))) {
        if (deps.reply) await deps.reply(payload, m.authorOnly());
        return;
      }
      if (!cfg!.actions.create_issue.enabled) {
        if (deps.reply) await deps.reply(payload, m.createIssueDisabled());
        return;
      }
      const now = deps.now?.();
      const description = (intent.argument ?? payload.body).trim() || 'Issue from conversation';
      // Not bound to revisionSha: issue creation does not depend on the head, so new commits must not invalidate it.
      const plan = newActionPlan({
        conversationId: conversation.id,
        actorId: payload.actorId ?? payload.actorLogin,
        actions: [{ type: 'create-issue', description }],
        requiredPermissions: cfg!.actions.create_issue.require_confirmation
          ? ['action:approve']
          : [],
        ...(now !== undefined ? { now } : {}),
      });
      if (cfg!.actions.create_issue.require_confirmation) {
        await insertActionPlan(db, payload.tenantId, plan, now);
        await updateConversation(db, conversation.id, { state: 'waiting-confirmation' }, now);
        if (deps.reply) await deps.reply(payload, proposalMessage(plan, m));
      } else {
        await db.transaction().execute(async (trx) => {
          await insertActionPlan(trx, payload.tenantId, { ...plan, status: 'approved' }, now);
          await enqueueJob(trx, {
            tenantId: payload.tenantId,
            type: 'action_execute',
            payload: { tenantId: payload.tenantId, planId: plan.id },
            dedupeKey: `action-execute:${plan.id}`,
          });
        });
        await updateConversation(db, conversation.id, { state: 'active' }, now);
        if (deps.reply) await deps.reply(payload, m.autoApproved({ planId: plan.id }));
      }
      return;
    }

    if (
      intent.intent === 'implement-issue' &&
      payload.target.kind === 'issue' &&
      payload.repositoryId &&
      payload.issueNumber !== undefined
    ) {
      const now = deps.now?.();
      // No CR on an issue, so check repository write access.
      if (!(await canWriteRepository(deps, payload).catch(() => false))) {
        if (deps.reply) await deps.reply(payload, m.authorOnly());
        return;
      }
      if (!cfg!.actions.autofix.enabled) {
        if (deps.reply) await deps.reply(payload, m.implementDisabled());
        return;
      }
      const description =
        (intent.argument ?? `Implement issue #${payload.issueNumber}`).trim() ||
        `Implement issue #${payload.issueNumber}`;
      await proposeBranchWriteAction({
        db,
        payload,
        conversation,
        cfg: cfg!,
        actions: [{ type: 'create-cr-from-issue', description, issueNumber: payload.issueNumber }],
        m,
        ...(deps.reply ? { reply: deps.reply } : {}),
        ...(now !== undefined ? { now } : {}),
      });
      return;
    }

    if (intent.intent === 'explain-finding' && payload.repositoryId && payload.changeRequestId) {
      await enqueueJob(db, {
        tenantId: payload.tenantId,
        type: 'explain_finding',
        payload: {
          tenantId: payload.tenantId,
          repositoryId: payload.repositoryId,
          changeRequestId: payload.changeRequestId,
          targetKind: payload.target.kind === 'review-thread' ? 'review-thread' : 'change-request',
          targetNativeId: payload.target.nativeId,
          ...(payload.anchorPath ? { anchorPath: payload.anchorPath } : {}),
          // Lets the publish idempotency key tell a retry from a repeated question.
          ...(payload.commentNativeId ? { requestId: payload.commentNativeId } : {}),
        },
        dedupeKey: `explain:${payload.changeRequestId}:${payload.anchorPath ?? payload.target.nativeId}`,
      });
      return;
    }

    if ((intent.intent === 'propose-learning' || intent.intent === 'approve-learning') && payload.repositoryId) {
      const learningDeps = {
        db,
        payload: { ...payload, repositoryId: payload.repositoryId },
        m,
        reply: (text: string) => (deps.reply ? deps.reply(payload, text) : Promise.resolve()),
        ...(deps.resolveActorPermission ? { resolveActorPermission: deps.resolveActorPermission } : {}),
        requireApproval: cfg?.knowledge.learnings.require_repo_admin_approval ?? true,
      };
      await (intent.intent === 'propose-learning'
        ? proposeLearningFromComment(learningDeps, intent.argument)
        : approveLearningFromComment(learningDeps, intent.argument));
      return;
    }

    if (intent.intent === 'feedback' && payload.repositoryId) {
      const cls = (intent.argument ?? '').trim().toLowerCase();
      if (!isFeedbackClass(cls)) return;
      const target = await resolveFeedbackTarget(db, {
        tenantId: payload.tenantId,
        repositoryId: payload.repositoryId,
        changeRequestId: payload.changeRequestId,
        nativeId: payload.target.nativeId,
      });
      const now = deps.now?.();
      await insertFeedback(
        db,
        payload.tenantId,
        {
          repositoryId: payload.repositoryId,
          class: cls,
          actor: payload.actorLogin,
          ...(target ? { fingerprint: target.fingerprint, findingId: target.findingId } : {}),
        },
        now,
      );
      // Only proposes; a human still has to approve.
      const learnings = cfg?.knowledge.learnings;
      if (target && learnings?.auto_propose) {
        const result = await maybeAutoProposeLearning(
          db,
          {
            tenantId: payload.tenantId,
            repositoryId: payload.repositoryId,
            fingerprint: target.fingerprint,
            claim: target.claim,
          },
          {
            threshold: learnings.auto_propose_threshold,
            isSuspicious: (t) => detectInjectionAttempt(t).suspicious,
            ...(now !== undefined ? { now } : {}),
          },
        );
        if (result.blocked) {
          await db
            .insertInto('audit_events')
            .values({
              id: uuidv7(),
              tenant_id: payload.tenantId,
              actor: 'auto-propose',
              action: 'security.auto-propose-blocked',
              target: payload.repositoryId,
              detail: { fingerprint: target.fingerprint } as unknown as Record<string, unknown>,
              created_at: new Date(now ?? Date.now()),
            })
            .execute();
        }
      }
      return;
    }

    if (deps.reply) {
      await deps.reply(payload, acknowledgement(intent, m));
    }
  };
}
