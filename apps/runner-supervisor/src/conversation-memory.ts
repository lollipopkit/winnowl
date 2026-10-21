import type { InteractionIntent } from '@reviewbot/conversation';
import { enqueueJob } from '@reviewbot/queue';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import { isKnowledgeTrusted } from './conversation-learning.js';
import type { ActorPermissionResolver } from './review-permissions.js';
import type { ConversationTurnDeps } from './conversation-turn.js';
import type { MemoryProposePayload } from './memory-propose.js';

/**
 * Commands whose comment can carry knowledge about the repository; comments that are no command at all (the
 * agent answers them) are considered too. Commands that only ask for an action (review, fix, ignore, …) carry
 * none, and learnings have their own explicit command.
 */
const KNOWLEDGE_BEARING: ReadonlySet<InteractionIntent> = new Set([
  'challenge-finding',
  'resolve-finding',
  'explain-finding',
  'reverify',
]);

/** Below this many characters (mention removed) a comment cannot state anything worth a model call. */
const MIN_COMMENT_CHARS = 40;

/**
 * Drafts repository memory from comments addressed to the bot: enqueues memory_propose with the comment
 * as source when the repository has memory enabled. Whether the memory applies without approval (forge
 * admin/maintain, or the repository turned approval off) is decided here, where the forge can be asked; the
 * job only reads the flag.
 */
export function createConversationMemoryProposer(deps: {
  botName: string;
  resolveActorPermission?: ActorPermissionResolver;
}): NonNullable<ConversationTurnDeps['afterAddressedTurn']> {
  return async ({ db, payload, intent, findingClaim }) => {
    const { repositoryId } = payload;
    if (!repositoryId) return;
    if (intent && !KNOWLEDGE_BEARING.has(intent.intent)) return;
    const text = payload.body.replace(new RegExp(`@${escapeRegExp(deps.botName)}\\b`, 'gi'), '').trim();
    if (text.length < MIN_COMMENT_CHARS) return;
    const cfg = await loadEffectiveConfig(db, payload.tenantId, repositoryId);
    if (!cfg.knowledge.memory.enabled) return;

    const trusted =
      !cfg.knowledge.memory.require_approval || (await isKnowledgeTrusted(deps.resolveActorPermission, repositoryId, payload));
    const revision = payload.changeRequestId
      ? await db
          .selectFrom('revisions')
          .select('id')
          .where('change_request_id', '=', payload.changeRequestId)
          .orderBy('created_at', 'desc')
          .limit(1)
          .executeTakeFirst()
      : undefined;
    const job: MemoryProposePayload = {
      tenantId: payload.tenantId,
      repositoryId,
      ...(revision ? { revisionId: revision.id } : {}),
      conversation: {
        body: text,
        actorLogin: payload.actorLogin,
        trusted,
        targetNativeId: payload.target.nativeId,
        ...(payload.commentNativeId ? { commentNativeId: payload.commentNativeId } : {}),
        ...(findingClaim ? { findingClaim } : {}),
      },
    };
    await enqueueJob(db, {
      tenantId: payload.tenantId,
      type: 'memory_propose',
      payload: { ...job },
      dedupeKey: `memory-propose:comment:${payload.commentNativeId ?? payload.turnId ?? payload.target.nativeId}`,
    });
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
