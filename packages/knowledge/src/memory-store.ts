import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { orderKnowledgeForPaths } from './retrieval.js';
import type { AgentMemory, AgentMemoryStatus, MemoryKind, MemorySourceComment, RetrievalItem } from './types.js';

// Agent memory: a one-line-per-entry index is injected up front and bodies are read lazily via a
// read-only tool. No embeddings; the agent picks entries by summary.

/** Index cap; overflow is truncated with an explicit notice, never silently dropped. */
export const MEMORY_INDEX_MAX_LINES = 30;

/** Per-repo dedup key. */
export function normalizeMemoryTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function rowToMemory(row: {
  id: string;
  kind: string;
  title: string;
  summary: string;
  body: string;
  selector: string | null;
  links: unknown;
  origin_review_id: string | null;
  status: string;
  expires_at: unknown;
  version: number;
  proposed_by: string | null;
  source_comment_ref: unknown;
}): AgentMemory {
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    title: row.title,
    summary: row.summary,
    body: row.body,
    ...(row.selector !== null ? { selector: row.selector } : {}),
    links: Array.isArray(row.links) ? (row.links as string[]) : [],
    ...(row.origin_review_id !== null ? { originReviewId: row.origin_review_id } : {}),
    status: row.status as AgentMemoryStatus,
    ...(row.expires_at ? { expiresAt: (row.expires_at as Date).getTime() } : {}),
    version: row.version,
    ...(row.proposed_by !== null ? { proposedBy: row.proposed_by } : {}),
    ...(row.source_comment_ref ? { sourceCommentRef: row.source_comment_ref as MemorySourceComment } : {}),
  };
}

export function newAgentMemory(input: {
  kind: MemoryKind;
  title: string;
  summary: string;
  body: string;
  selector?: string;
  links?: string[];
  originReviewId?: string;
  expiresAt?: number;
  /** Set for memories drafted from a comment; `proposed` waits for an admin. */
  status?: 'active' | 'proposed';
  proposedBy?: string;
  sourceCommentRef?: MemorySourceComment;
  now?: number;
}): AgentMemory {
  return {
    id: uuidv7(input.now),
    kind: input.kind,
    title: normalizeMemoryTitle(input.title),
    summary: input.summary,
    body: input.body,
    ...(input.selector !== undefined ? { selector: input.selector } : {}),
    links: input.links ?? [],
    ...(input.originReviewId !== undefined ? { originReviewId: input.originReviewId } : {}),
    status: input.status ?? 'active',
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    version: 1,
    ...(input.proposedBy !== undefined ? { proposedBy: input.proposedBy } : {}),
    ...(input.sourceCommentRef !== undefined ? { sourceCommentRef: input.sourceCommentRef } : {}),
  };
}

export async function insertAgentMemory(db: Db, tenantId: string, repositoryId: string, memory: AgentMemory, now?: number): Promise<void> {
  const at = new Date(now ?? Date.now());
  await db
    .insertInto('agent_memories')
    .values({
      id: memory.id,
      tenant_id: tenantId,
      repository_id: repositoryId,
      kind: memory.kind,
      title: memory.title,
      summary: memory.summary,
      body: memory.body,
      selector: memory.selector ?? null,
      links: JSON.stringify(memory.links) as unknown as string[],
      origin_review_id: memory.originReviewId ?? null,
      status: memory.status,
      expires_at: memory.expiresAt !== undefined ? new Date(memory.expiresAt) : null,
      version: memory.version,
      proposed_by: memory.proposedBy ?? null,
      source_comment_ref: (memory.sourceCommentRef ?? null) as unknown as Record<string, unknown> | null,
      created_at: at,
      updated_at: at,
    })
    .execute();
}

/** Statuses that hold a title; proposals and rejections never shadow or update a live entry. */
const LIVE_STATUSES = ['active', 'archived'] as const;

/** Active memories in created_at order (stable index order); the limit only guards against runaway growth. */
export async function listAgentMemories(db: Db, tenantId: string, repositoryId: string): Promise<AgentMemory[]> {
  const rows = await db
    .selectFrom('agent_memories')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('repository_id', '=', repositoryId)
    .where('status', '=', 'active')
    .orderBy('created_at', 'asc')
    .limit(500)
    .execute();
  return rows.map(rowToMemory);
}

/**
 * Upsert by `(tenant, repo, title)`: an existing row (archived included) is updated in place, version
 * bumped and reactivated; otherwise inserted.
 */
export async function upsertAgentMemory(
  db: Db,
  tenantId: string,
  repositoryId: string,
  memory: AgentMemory,
  now?: number,
): Promise<{ id: string; updated: boolean }> {
  const at = new Date(now ?? Date.now());
  const existing = await db
    .selectFrom('agent_memories')
    .select(['id', 'version'])
    .where('tenant_id', '=', tenantId)
    .where('repository_id', '=', repositoryId)
    .where('title', '=', memory.title)
    .where('status', 'in', LIVE_STATUSES)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable('agent_memories')
      .set({
        kind: memory.kind,
        summary: memory.summary,
        body: memory.body,
        selector: memory.selector ?? null,
        links: JSON.stringify(memory.links) as unknown as string[],
        origin_review_id: memory.originReviewId ?? null,
        status: 'active',
        expires_at: memory.expiresAt !== undefined ? new Date(memory.expiresAt) : null,
        version: existing.version + 1,
        updated_at: at,
      })
      .where('id', '=', existing.id)
      .execute();
    return { id: existing.id, updated: true };
  }
  await insertAgentMemory(db, tenantId, repositoryId, memory, now);
  return { id: memory.id, updated: false };
}

export async function agentMemoryExists(db: Db, tenantId: string, repositoryId: string, title: string): Promise<boolean> {
  const row = await db
    .selectFrom('agent_memories')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('repository_id', '=', repositoryId)
    .where('title', '=', normalizeMemoryTitle(title))
    .where('status', 'in', LIVE_STATUSES)
    .executeTakeFirst();
  return row !== undefined;
}

/** A pending proposal with this title, so a repeated comment does not queue the same memory twice. */
export async function proposedAgentMemoryExists(db: Db, tenantId: string, repositoryId: string, title: string): Promise<boolean> {
  const row = await db
    .selectFrom('agent_memories')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .where('repository_id', '=', repositoryId)
    .where('title', '=', normalizeMemoryTitle(title))
    .where('status', '=', 'proposed')
    .executeTakeFirst();
  return row !== undefined;
}

export interface ProposedAgentMemory extends AgentMemory {
  repositoryId: string;
  createdAt: number;
  updatedAt: number;
}

/** Proposals (`pending`) or decided proposals (`done`, rejected or approved since `since`) across the tenant. */
export async function listAgentMemoryProposals(
  db: Db,
  tenantId: string,
  view: 'pending' | 'done',
  opts: { since?: number; limit?: number } = {},
): Promise<ProposedAgentMemory[]> {
  let q = db
    .selectFrom('agent_memories')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    // Only memories that went through approval carry a source comment.
    .where('source_comment_ref', 'is not', null);
  q =
    view === 'pending'
      ? q.where('status', '=', 'proposed')
      : q.where('status', '!=', 'proposed').where('updated_at', '>=', new Date(opts.since ?? 0));
  const rows = await q.orderBy('updated_at', 'desc').limit(opts.limit ?? 200).execute();
  return rows.map((r) => ({
    ...rowToMemory(r),
    repositoryId: r.repository_id,
    createdAt: r.created_at.getTime(),
    updatedAt: r.updated_at.getTime(),
  }));
}

/**
 * Approve or reject a proposed memory. An approved proposal whose title already has a live entry is merged
 * into that entry (one live row per title), and the proposal row is removed.
 */
export async function decideAgentMemoryProposal(
  db: Db,
  tenantId: string,
  id: string,
  decision: 'approve' | 'reject',
  now?: number,
): Promise<{ ok: true; memory: AgentMemory } | { ok: false; reason: 'not_found' | 'not_proposed' }> {
  const at = new Date(now ?? Date.now());
  return db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom('agent_memories')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { ok: false, reason: 'not_found' } as const;
    if (row.status !== 'proposed') return { ok: false, reason: 'not_proposed' } as const;
    if (decision === 'reject') {
      await tx.updateTable('agent_memories').set({ status: 'rejected', updated_at: at }).where('id', '=', id).execute();
      return { ok: true, memory: rowToMemory({ ...row, status: 'rejected' }) } as const;
    }
    const live = await tx
      .selectFrom('agent_memories')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('repository_id', '=', row.repository_id)
      .where('title', '=', row.title)
      .where('status', 'in', LIVE_STATUSES)
      .forUpdate()
      .executeTakeFirst();
    if (!live) {
      await tx.updateTable('agent_memories').set({ status: 'active', updated_at: at }).where('id', '=', id).execute();
      return { ok: true, memory: rowToMemory({ ...row, status: 'active' }) } as const;
    }
    const merged = {
      kind: row.kind,
      summary: row.summary,
      body: row.body,
      selector: row.selector,
      proposed_by: row.proposed_by,
      source_comment_ref: row.source_comment_ref,
      status: 'active',
      version: live.version + 1,
      updated_at: at,
    };
    await tx.deleteFrom('agent_memories').where('id', '=', id).execute();
    await tx.updateTable('agent_memories').set(merged).where('id', '=', live.id).execute();
    return { ok: true, memory: rowToMemory({ ...live, ...merged }) } as const;
  });
}

/** Archive by title (consolidation drops); rows are kept for provenance. Returns the count. */
export async function archiveAgentMemories(db: Db, tenantId: string, repositoryId: string, titles: readonly string[], now?: number): Promise<number> {
  if (titles.length === 0) return 0;
  const result = await db
    .updateTable('agent_memories')
    .set({ status: 'archived', updated_at: new Date(now ?? Date.now()) })
    .where('tenant_id', '=', tenantId)
    .where('repository_id', '=', repositoryId)
    .where('status', '=', 'active')
    .where('title', 'in', titles.map(normalizeMemoryTitle))
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

/** Archive expired entries. Returns the count. */
export async function archiveExpiredAgentMemories(db: Db, tenantId: string, repositoryId: string, now?: number): Promise<number> {
  const at = new Date(now ?? Date.now());
  const result = await db
    .updateTable('agent_memories')
    .set({ status: 'archived', updated_at: at })
    .where('tenant_id', '=', tenantId)
    .where('repository_id', '=', repositoryId)
    .where('status', '=', 'active')
    .where('expires_at', 'is not', null)
    .where('expires_at', '<', at)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

export interface MemoryIndex {
  /** One line per entry, plus a notice line when truncated; undefined when nothing applies. */
  indexText?: string;
  /** Applicable entries in index order; source for memory_read. */
  entries: AgentMemory[];
  /** Entries cut by the index cap; when > 0 indexText already has the notice line. */
  truncated: number;
}

/**
 * Build the injected index: drop expired / non-matching selectors (via orderKnowledgeForPaths),
 * render `- [kind] title — summary`, and truncate at maxLines with an explicit notice.
 */
export function buildMemoryIndex(
  memories: AgentMemory[],
  paths: readonly string[],
  opts: { maxLines?: number; now?: number } = {},
): MemoryIndex {
  const maxLines = opts.maxLines ?? MEMORY_INDEX_MAX_LINES;
  // Reuse RetrievalItem filtering for expiry/selector, then map back by id.
  const items: RetrievalItem[] = memories.map((m) => ({
    id: m.id,
    category: 'agent-memory',
    content: m.summary,
    ...(m.selector !== undefined ? { selector: m.selector } : {}),
    ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
  }));
  const kept = orderKnowledgeForPaths(items, paths, opts.now !== undefined ? { now: opts.now } : {});
  const byId = new Map(memories.map((m) => [m.id, m]));
  const applicable = kept.map((i) => byId.get(i.id)!).filter(Boolean);

  const entries = applicable.slice(0, maxLines);
  const truncated = applicable.length - entries.length;
  if (entries.length === 0) return { entries: [], truncated: 0 };

  const lines = entries.map((m) => `- [${m.kind}] ${m.title} — ${m.summary}`);
  if (truncated > 0) lines.push(`(另有 ${truncated} 条记忆超出索引上限未列出;待巩固)`);
  return { indexText: lines.join('\n'), entries, truncated };
}
