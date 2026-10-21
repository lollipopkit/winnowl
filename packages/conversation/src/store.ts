import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { Conversation, ConversationMessage } from './types.js';

/** Messages are short-lived; context is rebuilt from the persisted summary. */

function rowToConversation(row: {
  id: string;
  tenant_id: string;
  target_kind: string;
  target_native_id: string;
  state: string;
  context_revision_sha: string | null;
  summary: string;
  active_task_id: string | null;
  repository_id: string | null;
  change_request_id: string | null;
}): Conversation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    target: {
      kind: row.target_kind as Conversation['target']['kind'],
      nativeId: row.target_native_id,
    },
    state: row.state as Conversation['state'],
    ...(row.context_revision_sha !== null ? { contextRevisionSha: row.context_revision_sha } : {}),
    summary: row.summary,
    ...(row.active_task_id !== null ? { activeTaskId: row.active_task_id } : {}),
    ...(row.repository_id !== null ? { repositoryId: row.repository_id } : {}),
    ...(row.change_request_id !== null ? { changeRequestId: row.change_request_id } : {}),
  };
}

export async function insertConversation(
  db: Db,
  conversation: Conversation,
  now?: number,
): Promise<void> {
  const at = new Date(now ?? Date.now());
  await db
    .insertInto('conversations')
    .values({
      id: conversation.id,
      tenant_id: conversation.tenantId,
      target_kind: conversation.target.kind,
      target_native_id: conversation.target.nativeId,
      state: conversation.state,
      context_revision_sha: conversation.contextRevisionSha ?? null,
      summary: conversation.summary,
      active_task_id: conversation.activeTaskId ?? null,
      repository_id: conversation.repositoryId ?? null,
      change_request_id: conversation.changeRequestId ?? null,
      created_at: at,
      updated_at: at,
    })
    .execute();
}

export async function loadConversation(
  db: Db,
  tenantId: string,
  id: string,
): Promise<Conversation | null> {
  const row = await db
    .selectFrom('conversations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? rowToConversation(row) : null;
}

export async function findConversationByTarget(
  db: Db,
  tenantId: string,
  kind: Conversation['target']['kind'],
  nativeId: string,
  binding?: { repositoryId?: string; changeRequestId?: string },
): Promise<Conversation | null> {
  let query = db
    .selectFrom('conversations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('target_kind', '=', kind)
    .where('target_native_id', '=', nativeId);
  // Missing bindings are part of the target identity, not wildcards. A webhook that
  // cannot resolve its repository/CR must not inherit another target's conversation.
  if (binding?.repositoryId) query = query.where('repository_id', '=', binding.repositoryId);
  else query = query.where('repository_id', 'is', null);
  if (binding?.changeRequestId)
    query = query.where('change_request_id', '=', binding.changeRequestId);
  else query = query.where('change_request_id', 'is', null);
  const row = await query.orderBy('created_at', 'desc').executeTakeFirst();
  return row ? rowToConversation(row) : null;
}

/**
 * A unique index enforces one conversation per target + bindings; on a concurrent insert the
 * winner is read back.
 */
export async function findOrCreateConversationByTarget(
  db: Db,
  input: {
    tenantId: string;
    target: Conversation['target'];
    repositoryId?: string;
    changeRequestId?: string;
  },
): Promise<Conversation> {
  const binding = {
    ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
    ...(input.changeRequestId ? { changeRequestId: input.changeRequestId } : {}),
  };
  const existing = await findConversationByTarget(
    db,
    input.tenantId,
    input.target.kind,
    input.target.nativeId,
    binding,
  );
  if (existing) return existing;
  const conversation = newConversation(input);
  try {
    await insertConversation(db, conversation);
    return conversation;
  } catch (error) {
    if ((error as { code?: string }).code !== '23505') throw error;
  }
  const winner = await findConversationByTarget(
    db,
    input.tenantId,
    input.target.kind,
    input.target.nativeId,
    binding,
  );
  if (winner) return winner;
  throw new Error('conversation insert conflicted but no target conversation was found');
}

/** Not persisted; the caller inserts it. */
export function newConversation(input: {
  tenantId: string;
  target: Conversation['target'];
  summary?: string;
  contextRevisionSha?: string;
  repositoryId?: string;
  changeRequestId?: string;
  now?: number;
}): Conversation {
  return {
    id: uuidv7(input.now),
    tenantId: input.tenantId,
    target: input.target,
    state: 'active',
    ...(input.contextRevisionSha !== undefined
      ? { contextRevisionSha: input.contextRevisionSha }
      : {}),
    summary: input.summary ?? '',
    ...(input.repositoryId !== undefined ? { repositoryId: input.repositoryId } : {}),
    ...(input.changeRequestId !== undefined ? { changeRequestId: input.changeRequestId } : {}),
  };
}

export async function listConversations(
  db: Db,
  tenantId: string,
  limit = 100,
): Promise<Conversation[]> {
  const rows = await db
    .selectFrom('conversations')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map(rowToConversation);
}

export async function listConversationsPage(
  db: Db,
  tenantId: string,
  opts: {
    limit: number;
    offset: number;
    sort: string;
    dir: 'asc' | 'desc';
    state?: string | undefined;
    q?: string | undefined;
  },
): Promise<{ items: Conversation[]; total: number }> {
  let base = db.selectFrom('conversations').where('tenant_id', '=', tenantId);
  if (opts.state) base = base.where('state', '=', opts.state);
  if (opts.q) base = base.where('summary', 'ilike', `%${opts.q}%`);
  const totalRow = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const sortCol = opts.sort === 'state' ? 'state' : 'updated_at';
  const rows = await base
    .selectAll()
    .orderBy(sortCol as 'updated_at', opts.dir)
    .orderBy('id', 'desc')
    .limit(opts.limit)
    .offset(opts.offset)
    .execute();
  return { items: rows.map(rowToConversation), total: Number(totalRow?.n ?? 0) };
}

export async function updateConversation(
  db: Db,
  id: string,
  patch: {
    state?: Conversation['state'];
    summary?: string;
    contextRevisionSha?: string;
    activeTaskId?: string | null;
  },
  now?: number,
): Promise<void> {
  await db
    .updateTable('conversations')
    .set({
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.contextRevisionSha !== undefined
        ? { context_revision_sha: patch.contextRevisionSha }
        : {}),
      ...(patch.activeTaskId !== undefined ? { active_task_id: patch.activeTaskId } : {}),
      updated_at: new Date(now ?? Date.now()),
    })
    .where('id', '=', id)
    .execute();
}

export interface AppendMessageInput {
  conversationId: string;
  actorLogin: string;
  body: string;
  now?: number;
}

export async function appendMessage(
  db: Db,
  input: AppendMessageInput,
): Promise<ConversationMessage> {
  const id = uuidv7(input.now);
  const createdAt = new Date(input.now ?? Date.now());
  await db
    .insertInto('conversation_messages')
    .values({
      id,
      conversation_id: input.conversationId,
      actor_login: input.actorLogin,
      body: input.body,
      created_at: createdAt,
    })
    .execute();
  await db
    .updateTable('conversations')
    .set({ updated_at: createdAt })
    .where('id', '=', input.conversationId)
    .execute();
  return {
    id,
    conversationId: input.conversationId,
    actorLogin: input.actorLogin,
    body: input.body,
    createdAt: createdAt.toISOString(),
  };
}

export async function listMessages(
  db: Db,
  conversationId: string,
  limit = 200,
): Promise<ConversationMessage[]> {
  const rows = await db
    .selectFrom('conversation_messages')
    .selectAll()
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    actorLogin: r.actor_login,
    body: r.body,
    createdAt: (r.created_at as unknown as Date).toISOString(),
  }));
}
