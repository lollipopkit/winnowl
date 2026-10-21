import {
  appendMessage,
  findOrCreateConversationByTarget,
  hasMention,
  isReadOnlyIntent,
  parseCommand,
  updateConversation,
  type Conversation,
  type ParsedIntent,
} from '@reviewbot/conversation';
import { detectInjectionAttempt } from '@reviewbot/agent-pi';
import { botMention } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import { withLlmTraceContext } from '@reviewbot/telemetry';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import { resolveFeedbackTarget } from './feedback-target.js';
import { botMessages } from './locale.js';
import { JobExecutionError, type JobHandler, type JobHandlerDb } from './supervisor.js';

/** conversation_turn job payload (enqueued on comment.created). */
export interface ConversationTurnPayload {
  tenantId: string;
  target: { kind: 'change-request' | 'issue' | 'review-thread'; nativeId: string };
  actorLogin: string;
  /** Provider actor id (same identity space as the confirmation endpoint's auth.actorId); ActionPlan ownership uses it, not login. */
  actorId?: string;
  /** Third-party bot author (decided at ingress): only read-only intents are allowed. */
  actorIsBot?: boolean;
  body: string;
  /** Labels this turn's LLM spans so uninstall can erase the Langfuse traces. */
  installationId?: string;
  /** Change-request comments: resolved internal ids, used to trigger reviews. */
  repositoryId?: string;
  changeRequestId?: string;
  /**
   * The comment's change request was not registered when it arrived (its opened event can come
   * later): resolved here by number; the job retries until it is there.
   */
  pendingChange?: { number: number; kind: string };
  /** Issue comments: issue number, for `@winnowl plan` (issue_enrich). */
  issueNumber?: number;
  /** Review-thread comments: file path, used to pick the most relevant finding. */
  anchorPath?: string;
  /** Native id of the triggering comment; publish idempotency keys distinguish requests by it. */
  commentNativeId?: string;
  /**
   * This turn's job id; identifies the request for reply idempotency when there is no commentNativeId
   * (retries reuse it, a new turn gets a new one).
   */
  turnId?: string;
  /**
   * A command from one of our checkboxes being ticked (ingress verified the comment is ours and the box
   * went from unchecked to checked). `review-checkbox`: status comment; `fix-checkbox`: review body.
   */
  command?: { kind: 'review-checkbox' | 'fix-checkbox'; commentNativeId: string };
}

export interface ConversationRouteContext {
  intent: ParsedIntent;
  conversation: Conversation;
  payload: ConversationTurnPayload;
  db: JobHandlerDb;
}

export interface ConversationTurnDeps {
  botName: string;
  /** Defaults to true. */
  requireMention?: boolean;
  /** Routes the parsed intent; high-risk actions go through policy/approval there, never on classification alone. */
  route: (ctx: ConversationRouteContext) => Promise<void>;
  /** Replies before routing (a comment whose pull request could not be found). */
  reply?: ConversationReply;
  /**
   * Hands a comment addressed to the bot that is not a command to the conversation agent (its own job). The
   * agent runs commands through `route` with the commenter's permissions, so it grants nothing new.
   */
  startAgent?: (input: { db: JobHandlerDb; payload: ConversationTurnPayload; conversation: Conversation; findingClaim?: string }) => Promise<void>;
  /** Called right before routing a valid intent to react with eyes; a failure does not block routing. */
  acknowledge?: (payload: ConversationTurnPayload) => Promise<void>;
  /**
   * Registers a change request the forge knows but no webhook told us about (opened before the App was
   * installed, or its events were lost), from the forge's API; resolves to its id, or null if unavailable.
   */
  registerChangeRequest?: (input: { tenantId: string; repositoryId: string; number: number; kind: string }) => Promise<string | null>;
  /**
   * Called after a comment addressed to the bot by a person (not a checkbox, not a bot, no injection
   * suspected), e.g. to draft repository memory from it; a failure does not fail the turn.
   */
  afterAddressedTurn?: (input: {
    db: JobHandlerDb;
    payload: ConversationTurnPayload;
    intent: ParsedIntent | null;
    findingClaim?: string;
  }) => Promise<void>;
}

/**
 * Handles one comment: upsert the conversation by target, record the message, parse the command, route.
 * Each message is short-lived; there is no persistent Pi session.
 */
/**
 * Attempt from which an unknown change request is read from the forge. Earlier attempts wait for its opened
 * event (GitHub sometimes delivers it after the first comments): registering first would make that event a
 * no-op and skip the automatic review.
 */
const FORGE_LOOKUP_ATTEMPT = 3;

/** An actor with more injection attempts than this within the window gets no responses. */
const INJECTION_WINDOW_MS = 60 * 60 * 1000;
const INJECTION_THRESHOLD = 3;

export function createConversationTurnHandler(deps: ConversationTurnDeps): JobHandler {
  return async ({ job, db, log }) => {
    let payload: ConversationTurnPayload = {
      ...(job.payload as unknown as ConversationTurnPayload),
      turnId: job.id,
    };

    /*
     * A command on a pull request whose opened event has not arrived yet (GitHub sometimes delivers
     * it after the first comments): look again, and retry the job until it is registered — the
     * command used to be dropped without a word. Out of retries: say so.
     */
    if (!payload.changeRequestId && payload.pendingChange && payload.repositoryId) {
      const pending = payload.pendingChange;
      const found = await db
        .selectFrom('change_requests')
        .select('id')
        .where('tenant_id', '=', payload.tenantId)
        .where('repository_id', '=', payload.repositoryId)
        .where('number', '=', pending.number)
        .where('kind', '=', pending.kind)
        .executeTakeFirst();
      const registered =
        !found && deps.registerChangeRequest && job.attemptCount >= FORGE_LOOKUP_ATTEMPT
          ? await deps.registerChangeRequest({ tenantId: payload.tenantId, repositoryId: payload.repositoryId, number: pending.number, kind: pending.kind })
          : null;
      const changeRequestId = found?.id ?? registered;
      if (changeRequestId) {
        payload = { ...payload, changeRequestId };
      } else if (job.attemptCount < job.maxAttempts) {
        throw new JobExecutionError(`change request #${pending.number} is not registered yet`, 'retryable_provider', true);
      } else {
        const cfg = await loadEffectiveConfig(db, payload.tenantId, payload.repositoryId).catch(() => undefined);
        if (deps.reply) await deps.reply(payload, botMessages(cfg?.language).conversation.changeRequestUnknown({ bot: botMention() }));
        return;
      }
    }

    const conversation = await findOrCreateConversationByTarget(db, {
      tenantId: payload.tenantId,
      target: payload.target,
      ...(payload.repositoryId !== undefined ? { repositoryId: payload.repositoryId } : {}),
      ...(payload.changeRequestId !== undefined
        ? { changeRequestId: payload.changeRequestId }
        : {}),
    });
    await appendMessage(db, {
      conversationId: conversation.id,
      actorLogin: payload.actorLogin,
      body: payload.body,
    });

    // Injection attempts are audited; only repeat offenders within the window are ignored (one suspicious
    // comment is not blocked, the agent's SECURITY_PREAMBLE covers that).
    const injection = detectInjectionAttempt(payload.body);
    if (injection.suspicious) {
      const nowMs = Date.now();
      await db
        .insertInto('audit_events')
        .values({
          id: uuidv7(),
          tenant_id: payload.tenantId,
          actor: payload.actorLogin,
          action: 'security.injection-attempt',
          target: payload.repositoryId ?? payload.target.nativeId,
          detail: {
            patterns: injection.patterns,
            conversationId: conversation.id,
          } as unknown as Record<string, unknown>,
          created_at: new Date(nowMs),
        })
        .execute();
      const recent = await db
        .selectFrom('audit_events')
        .select((eb) => eb.fn.countAll().as('n'))
        .where('tenant_id', '=', payload.tenantId)
        .where('actor', '=', payload.actorLogin)
        .where('action', '=', 'security.injection-attempt')
        .where('created_at', '>', new Date(nowMs - INJECTION_WINDOW_MS))
        .executeTakeFirst();
      if (Number(recent?.n ?? 0) > INJECTION_THRESHOLD) {
        log('conversation turn', {
          conversationId: conversation.id,
          intent: 'injection-throttled',
        });
        return;
      }
    }

    // chat config: enabled=false ignores the comment (still recorded); require_mention overrides the default.
    let requireMention = deps.requireMention ?? true;
    // Checkboxes trigger reviews, not chat, so the chat switch does not apply.
    if (payload.repositoryId && !payload.command) {
      const chat = (await loadEffectiveConfig(db, payload.tenantId, payload.repositoryId)).chat;
      if (!chat.enabled) {
        log('conversation turn', { conversationId: conversation.id, intent: 'chat-disabled' });
        return;
      }
      requireMention = chat.require_mention;
    }

    // LLM calls of this conversation share one context; the target is the Langfuse session.
    const turnTrace = {
      tenantId: payload.tenantId,
      // Missing for issue comments whose installation was not resolved at ingress.
      ...(payload.installationId ? { installationId: payload.installationId } : {}),
      sessionId: `conversation:${payload.target.nativeId}`,
      userId: payload.actorLogin,
      stage: 'conversation',
      tags: ['conversation', payload.target.kind],
    };

    /*
     * Replies in our finding threads need no mention (ingress lets only our threads through); third-party
     * bot replies are excluded so two review bots do not answer each other forever.
     */
    const findingThread =
      !payload.command && !payload.actorIsBot && payload.target.kind === 'review-thread' && payload.repositoryId
        ? await resolveFeedbackTarget(db, {
            tenantId: payload.tenantId,
            repositoryId: payload.repositoryId,
            changeRequestId: payload.changeRequestId,
            nativeId: payload.target.nativeId,
          })
        : null;
    const addressed = hasMention(payload.body, deps.botName) || findingThread !== null;
    const intent: ParsedIntent | null = payload.command
      ? { intent: payload.command.kind === 'fix-checkbox' ? 'fix-all' : 'review', source: 'command' }
      : parseCommand(payload.body, deps.botName, { requireMention: requireMention && findingThread === null });
    // Not a command: a person's comment addressed to us goes to the conversation agent. Suspected injections and
    // other bots get no agent (bots answering each other would never stop).
    if (!intent && addressed && !injection.suspicious && !payload.actorIsBot && !payload.command && deps.startAgent) {
      await deps.acknowledge?.(payload).catch(() => undefined);
      await deps.startAgent({ db, payload, conversation, ...(findingThread ? { findingClaim: findingThread.claim } : {}) });
    }
    // Third-party bot comments get read-only intents only (our own comments never reach here); otherwise any
    // bot that can comment could make us open branches.
    if (intent && payload.actorIsBot && !isReadOnlyIntent(intent.intent)) {
      log('conversation turn', {
        conversationId: conversation.id,
        intent: `bot-actor-blocked:${intent.intent}`,
      });
      return;
    }
    if (intent) {
      await deps.acknowledge?.(payload).catch((err) =>
        log('conversation acknowledge failed', {
          conversationId: conversation.id,
          error: (err as Error)?.message,
        }),
      );
      await withLlmTraceContext(turnTrace, () => deps.route({ intent, conversation, payload, db }));
    }
    if (addressed && !payload.command && !payload.actorIsBot && !injection.suspicious && deps.afterAddressedTurn) {
      await deps
        .afterAddressedTurn({ db, payload, intent, ...(findingThread ? { findingClaim: findingThread.claim } : {}) })
        .catch((err) => log('conversation after-turn failed', { conversationId: conversation.id, error: (err as Error)?.message }));
    }
    // Deterministic summary (no LLM): recent intents plus truncated messages.
    const digest = payload.body.replace(/\s+/g, ' ').trim().slice(0, 160);
    await updateConversation(db, conversation.id, {
      summary: `[${intent?.intent ?? 'none'}] ${payload.actorLogin}: ${digest}`,
    });
    log('conversation turn', { conversationId: conversation.id, intent: intent?.intent ?? 'none' });
  };
}

/** Posts the bot's reply in the conversation thread. */
export type ConversationReply = (
  payload: ConversationTurnPayload,
  markdown: string,
) => Promise<void>;
