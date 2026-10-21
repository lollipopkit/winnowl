import { randomUUID } from 'node:crypto';
import type { Db } from '@reviewbot/db';
import type { ChangeRequestRef } from '@reviewbot/domain';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import type { ConversationReply, ConversationTurnPayload } from './conversation-turn.js';

export interface ConversationReplyDeps {
  db: Db;
  /** Builds an authed Provider for a repositoryId. */
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
}

/**
 * Bot reply in a conversation, posted where the command came from: inline commands reply in their
 * thread, top-level ones on the PR, issue commands on the issue.
 */
export function createConversationReply(deps: ConversationReplyDeps): ConversationReply {
  /*
   * Idempotency key = request identity + reply index within the round. Request identity is the triggering
   * comment's native id, else the job id, else a one-off id (better a duplicate than a swallowed reply).
   * The index increments on the payload object, so replaying a round reproduces the same keys.
   */
  const adhocIds = new WeakMap<object, string>();
  const replyIndex = new WeakMap<object, number>();
  const requestIdOf = (payload: ConversationTurnPayload): string => {
    const explicit = payload.commentNativeId ?? payload.turnId;
    if (explicit) return explicit;
    let generated = adhocIds.get(payload);
    if (!generated) {
      generated = randomUUID();
      adhocIds.set(payload, generated);
    }
    return generated;
  };
  const keyFor = (payload: ConversationTurnPayload, scope: string): string => {
    const index = replyIndex.get(payload) ?? 0;
    replyIndex.set(payload, index + 1);
    return `conv-reply:${scope}:${requestIdOf(payload)}:${index}`;
  };

  return async (payload, markdown) => {
    if (!payload.repositoryId) return;
    const body = { markdown };

    // Issue command: reply at the issue top level (issue comment events always carry issueNumber).
    if (payload.target.kind === 'issue') {
      if (payload.issueNumber === undefined) return;
      const provider = await deps.buildProvider(payload.repositoryId);
      await provider.discussions.createTopLevelComment(
        { kind: 'issue', ref: { id: payload.target.nativeId, repositoryId: payload.repositoryId, nativeId: payload.target.nativeId, number: payload.issueNumber } },
        body,
        { key: keyFor(payload, `issue:${payload.target.nativeId}`) },
      );
      return;
    }

    if (!payload.changeRequestId) return;
    const cr = await deps.db
      .selectFrom('change_requests')
      .select(['id', 'repository_id', 'native_id', 'number', 'kind'])
      .where('id', '=', payload.changeRequestId)
      .executeTakeFirst();
    if (!cr) return;

    const provider = await deps.buildProvider(payload.repositoryId);
    const ref: ChangeRequestRef = {
      id: cr.id,
      repositoryId: cr.repository_id,
      nativeId: cr.native_id,
      number: cr.number,
      kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
    };

    // Inline thread: target.nativeId is the thread's first comment (see normalize's in_reply_to_id).
    if (payload.target.kind === 'review-thread') {
      await provider.discussions.reply(
        { nativeId: payload.target.nativeId, changeRequest: ref },
        body,
        { key: keyFor(payload, `thread:${payload.target.nativeId}`) },
      );
      return;
    }

    await provider.discussions.createTopLevelComment({ kind: 'change-request', ref }, body, {
      key: keyFor(payload, cr.id),
    });
  };
}
