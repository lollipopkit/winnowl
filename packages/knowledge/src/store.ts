import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { adoptionAllows, loadApprovedGlobalLearnings, loadGlobalLearningAdoptions, loadGlobalLearningsPolicy } from './global-store.js';
import { isLearningActive, transitionLearning, type LearningActor, type LearningTransitionResult } from './learning.js';
import { type CommentRef, type LearningBroadness, type LearningEnforcement, type LearningLocality, type LearningProposal, type LearningStatus, type RetrievalItem } from './types.js';

// State changes go through transitionLearning (Repo Admin approve/reject/revoke) before persisting.

function rowToProposal(row: {
  id: string;
  repository_id: string | null;
  broadness: string;
  locality: string;
  subject_ref: string | null;
  enforcement: string;
  selector: string | null;
  instruction: string;
  rationale: string;
  source_comment_ref: unknown;
  proposed_by: string;
  status: string;
  approved_by: string | null;
  approved_at: unknown;
  expires_at: unknown;
  version: number;
  usage_count?: number;
  last_used_at?: unknown;
  created_at?: unknown;
}): LearningProposal {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    broadness: row.broadness as LearningBroadness,
    locality: row.locality as LearningLocality,
    ...(row.subject_ref !== null ? { subjectRef: row.subject_ref } : {}),
    enforcement: row.enforcement as LearningEnforcement,
    ...(row.selector !== null ? { selector: row.selector } : {}),
    instruction: row.instruction,
    rationale: row.rationale,
    ...(row.source_comment_ref ? { sourceCommentRef: row.source_comment_ref as CommentRef } : {}),
    proposedBy: row.proposed_by,
    status: row.status as LearningStatus,
    ...(row.approved_by !== null ? { approvedBy: row.approved_by } : {}),
    ...(row.approved_at ? { approvedAt: (row.approved_at as Date).getTime() } : {}),
    ...(row.expires_at ? { expiresAt: (row.expires_at as Date).getTime() } : {}),
    version: row.version,
    ...(row.usage_count !== undefined ? { usageCount: row.usage_count } : {}),
    ...(row.last_used_at ? { lastUsedAt: (row.last_used_at as Date).getTime() } : {}),
    ...(row.created_at ? { createdAt: (row.created_at as Date).getTime() } : {}),
  };
}

/** Increment usage_count and set last_used_at for learnings selected by a review. Global learnings are not counted. */
export async function markLearningsUsed(db: Db, ids: readonly string[], now?: number): Promise<void> {
  if (ids.length === 0) return;
  await db
    .updateTable('learning_proposals')
    .set((eb) => ({ usage_count: eb('usage_count', '+', 1), last_used_at: new Date(now ?? Date.now()) }))
    .where('id', 'in', [...ids])
    .execute();
}

export async function insertLearningProposal(db: Db, tenantId: string, proposal: LearningProposal, now?: number): Promise<void> {
  const at = new Date(now ?? Date.now());
  await db
    .insertInto('learning_proposals')
    .values({
      id: proposal.id,
      tenant_id: tenantId,
      repository_id: proposal.repositoryId,
      broadness: proposal.broadness,
      locality: proposal.locality,
      subject_ref: proposal.subjectRef ?? null,
      enforcement: proposal.enforcement,
      selector: proposal.selector ?? null,
      instruction: proposal.instruction,
      rationale: proposal.rationale,
      source_comment_ref: (proposal.sourceCommentRef ?? null) as unknown as Record<string, unknown> | null,
      proposed_by: proposal.proposedBy,
      status: proposal.status,
      approved_by: proposal.approvedBy ?? null,
      approved_at: proposal.approvedAt !== undefined ? new Date(proposal.approvedAt) : null,
      expires_at: proposal.expiresAt !== undefined ? new Date(proposal.expiresAt) : null,
      version: proposal.version,
      usage_count: 0,
      last_used_at: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
}

function normalizeInstruction(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Whether a proposed/approved learning with the same instruction exists (auto-proposal dedup).
 * Repository proposals compare within the repo; org proposals compare against repository_id IS NULL.
 */
export async function learningProposalExists(
  db: Db,
  tenantId: string,
  key: { instruction: string; repositoryId: string | null },
): Promise<boolean> {
  let q = db
    .selectFrom('learning_proposals')
    .select('instruction')
    .where('tenant_id', '=', tenantId)
    .where('status', 'in', ['proposed', 'approved']);
  q = key.repositoryId === null ? q.where('repository_id', 'is', null) : q.where('repository_id', '=', key.repositoryId);
  const rows = await q.execute();
  const norm = normalizeInstruction(key.instruction);
  return rows.some((r) => normalizeInstruction(r.instruction) === norm);
}

export async function loadLearningProposal(db: Db, tenantId: string, id: string): Promise<LearningProposal | null> {
  const row = await db.selectFrom('learning_proposals').selectAll().where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirst();
  return row ? rowToProposal(row) : null;
}

/** Unpaged: review-time loading and dedup need the complete set. */
export async function listLearningProposals(
  db: Db,
  tenantId: string,
  opts: { status?: LearningStatus | LearningStatus[] } = {},
): Promise<LearningProposal[]> {
  let q = db.selectFrom('learning_proposals').selectAll().where('tenant_id', '=', tenantId);
  if (opts.status) q = q.where('status', 'in', [opts.status].flat());
  const rows = await q.orderBy('created_at', 'desc').execute();
  return rows.map(rowToProposal);
}

export async function listLearningProposalsPage(
  db: Db,
  tenantId: string,
  opts: { limit: number; offset: number; sort: string; dir: 'asc' | 'desc'; status?: string | undefined; q?: string | undefined },
): Promise<{ items: LearningProposal[]; total: number }> {
  let base = db.selectFrom('learning_proposals').where('tenant_id', '=', tenantId);
  if (opts.status) base = base.where('status', '=', opts.status as LearningStatus);
  if (opts.q) base = base.where('instruction', 'ilike', `%${opts.q}%`);
  const totalRow = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const sortCol = opts.sort === 'status' ? 'status' : 'created_at';
  const rows = await base
    .selectAll()
    .orderBy(sortCol as 'created_at', opts.dir)
    .orderBy('id', 'desc')
    .limit(opts.limit)
    .offset(opts.offset)
    .execute();
  return { items: rows.map(rowToProposal), total: Number(totalRow?.n ?? 0) };
}

/**
 * Approved, still active learnings for one repository as retrieval items. Path/symbol learnings
 * carry a selector that orderKnowledge filters by path.
 */
export async function loadApprovedKnowledge(db: Db, tenantId: string, repositoryId: string): Promise<RetrievalItem[]> {
  const approved = await listLearningProposals(db, tenantId, { status: 'approved' });
  return approved
    .filter((p) => p.repositoryId === repositoryId && isLearningActive(p))
    .map((p) => ({
      id: p.id,
      category: 'approved-learning' as const,
      content: p.instruction,
      ...(p.locality !== 'none' && p.selector ? { selector: p.selector } : {}),
      ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}),
    }));
}

/** Broadness first (global<org<repo<user), then locality (none<path<symbol). */
function specificityOf(broadness: LearningBroadness, locality: LearningLocality): number {
  const b = broadness === 'user' ? 3 : broadness === 'repository' ? 2 : broadness === 'organization' ? 1 : 0;
  const l = locality === 'symbol' ? 2 : locality === 'path' ? 1 : 0;
  return b * 3 + l;
}

/**
 * Approved learnings applicable to a review: the union of global, organization, repository and
 * user (subject_ref matches a PR participant) learnings, with specificity and mandatory flags.
 */
export async function loadApplicableKnowledge(
  db: Db,
  ctx: { tenantId: string; repositoryId: string; participants?: string[] },
): Promise<RetrievalItem[]> {
  const participants = ctx.participants ?? [];
  const items: RetrievalItem[] = [];

  // Mandatory global learnings always apply; default ones are filtered by tenant policy/adoption.
  const policy = await loadGlobalLearningsPolicy(db, ctx.tenantId);
  const adoptions = await loadGlobalLearningAdoptions(db, ctx.tenantId);
  const now = Date.now();
  for (const g of await loadApprovedGlobalLearnings(db)) {
    // Expired global learnings stay approved but are no longer injected.
    if (g.expiresAt !== undefined && g.expiresAt <= now) continue;
    if (!adoptionAllows(g, policy, adoptions, ctx.repositoryId)) continue;
    items.push({
      id: g.id,
      category: 'approved-learning',
      content: g.instruction,
      ...(g.locality !== 'none' && g.selector ? { selector: g.selector } : {}),
      specificity: specificityOf('global', g.locality),
      ...(g.enforcement === 'mandatory' ? { mandatory: true } : {}),
      ...(g.expiresAt !== undefined ? { expiresAt: g.expiresAt } : {}),
    });
  }

  const approved = await listLearningProposals(db, ctx.tenantId, { status: 'approved' });
  for (const p of approved) {
    if (!isLearningActive(p)) continue;
    const applies =
      p.broadness === 'organization' ||
      (p.broadness === 'repository' && p.repositoryId === ctx.repositoryId) ||
      (p.broadness === 'user' && p.subjectRef !== undefined && participants.includes(p.subjectRef));
    if (!applies) continue;
    items.push({
      id: p.id,
      category: 'approved-learning',
      content: p.instruction,
      ...(p.locality !== 'none' && p.selector ? { selector: p.selector } : {}),
      ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}),
      specificity: specificityOf(p.broadness, p.locality),
      ...(p.enforcement === 'mandatory' ? { mandatory: true } : {}),
    });
  }
  return items;
}

export type TransitionAndPersistResult = LearningTransitionResult;

/** Load, transition (admin-gated) and persist a learning's status. */
export async function transitionAndPersist(
  db: Db,
  tenantId: string,
  id: string,
  input: { action: 'approve' | 'reject' | 'revoke' | 'expire'; actor?: LearningActor; now?: number },
): Promise<TransitionAndPersistResult> {
  const proposal = await loadLearningProposal(db, tenantId, id);
  if (!proposal) return { ok: false, reason: 'proposal not found' };
  const result = transitionLearning(proposal, input);
  if (result.ok && result.proposal) {
    const p = result.proposal;
    await db
      .updateTable('learning_proposals')
      .set({
        status: p.status,
        version: p.version,
        approved_by: p.approvedBy ?? null,
        approved_at: p.approvedAt !== undefined ? new Date(p.approvedAt) : null,
        updated_at: new Date(input.now ?? Date.now()),
      })
      .where('id', '=', id)
      .execute();
  }
  return result;
}

/** New proposed learning; defaults to repository broadness and no locality. */
export function newProposal(input: {
  repositoryId: string | null;
  broadness?: LearningBroadness;
  locality?: LearningLocality;
  selector?: string;
  subjectRef?: string;
  enforcement?: LearningEnforcement;
  instruction: string;
  rationale: string;
  proposedBy: string;
  sourceCommentRef?: CommentRef;
  /** Epoch ms; read-time expiry (`isLearningActive`). */
  expiresAt?: number;
  now?: number;
}): LearningProposal {
  const broadness = input.broadness ?? 'repository';
  const locality = input.locality ?? 'none';
  return {
    id: uuidv7(input.now),
    repositoryId: input.repositoryId,
    broadness,
    locality,
    ...(input.selector !== undefined ? { selector: input.selector } : {}),
    ...(input.subjectRef !== undefined ? { subjectRef: input.subjectRef } : {}),
    enforcement: input.enforcement ?? 'default',
    instruction: input.instruction,
    rationale: input.rationale,
    ...(input.sourceCommentRef !== undefined ? { sourceCommentRef: input.sourceCommentRef } : {}),
    proposedBy: input.proposedBy,
    status: 'proposed',
    version: 1,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
}
