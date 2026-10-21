import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { transitionLearning, type LearningActor, type LearningTransitionResult } from './learning.js';
import type { GlobalLearning, GlobalLearningAdoption, GlobalLearningDeliberation, GlobalLearningSource, GlobalLearningsPolicy, LearningEnforcement, LearningProposal, LearningStatus } from './types.js';

// Global learnings have no tenant/repository. Only platform operators may propose/approve them;
// the check lives in transitionLearning (broadness='global' requires actor.isPlatformOperator).

function rowToGlobal(row: {
  id: string;
  locality: string;
  selector: string | null;
  instruction: string;
  rationale: string;
  enforcement: string;
  status: string;
  proposed_by: string;
  approved_by: string | null;
  version: number;
  origin: string;
  confidence: string | null;
  deliberation: unknown;
  source: unknown;
  expires_at: Date | string | null;
}): GlobalLearning {
  return {
    id: row.id,
    locality: row.locality === 'path' ? 'path' : 'none',
    ...(row.selector !== null ? { selector: row.selector } : {}),
    instruction: row.instruction,
    rationale: row.rationale,
    enforcement: row.enforcement as LearningEnforcement,
    status: row.status as LearningStatus,
    proposedBy: row.proposed_by,
    ...(row.approved_by !== null ? { approvedBy: row.approved_by } : {}),
    version: row.version,
    origin: row.origin === 'auto' ? 'auto' : 'operator',
    ...(row.confidence !== null ? { confidence: Number(row.confidence) } : {}),
    ...(row.deliberation ? { deliberation: row.deliberation as GlobalLearningDeliberation } : {}),
    ...(row.source ? { source: row.source as GlobalLearningSource } : {}),
    ...(row.expires_at ? { expiresAt: new Date(row.expires_at).getTime() } : {}),
  };
}

export function newGlobalLearning(input: {
  locality?: 'none' | 'path';
  selector?: string;
  instruction: string;
  rationale: string;
  enforcement?: LearningEnforcement;
  proposedBy: string;
  /** Defaults to 'operator'; system multi-model proposals pass 'auto'. */
  origin?: 'operator' | 'auto';
  confidence?: number;
  deliberation?: GlobalLearningDeliberation;
  source?: GlobalLearningSource;
  /** Epoch ms; expired rules stay approved but are no longer injected or offered. */
  expiresAt?: number;
  now?: number;
}): GlobalLearning {
  return {
    id: uuidv7(input.now),
    locality: input.locality ?? 'none',
    ...(input.selector !== undefined ? { selector: input.selector } : {}),
    instruction: input.instruction,
    rationale: input.rationale,
    enforcement: input.enforcement ?? 'default',
    status: 'proposed',
    proposedBy: input.proposedBy,
    version: 1,
    origin: input.origin ?? 'operator',
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.deliberation !== undefined ? { deliberation: input.deliberation } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
}

export async function insertGlobalLearning(db: Db, g: GlobalLearning, now?: number): Promise<void> {
  const at = new Date(now ?? Date.now());
  await db
    .insertInto('global_learnings')
    .values({
      id: g.id,
      locality: g.locality,
      selector: g.selector ?? null,
      instruction: g.instruction,
      rationale: g.rationale,
      enforcement: g.enforcement,
      status: g.status,
      proposed_by: g.proposedBy,
      approved_by: g.approvedBy ?? null,
      version: g.version,
      origin: g.origin,
      confidence: g.confidence ?? null,
      deliberation: (g.deliberation ?? null) as unknown as Record<string, unknown> | null,
      source: (g.source ?? null) as unknown as Record<string, unknown> | null,
      expires_at: g.expiresAt !== undefined ? new Date(g.expiresAt) : null,
      created_at: at,
      updated_at: at,
    })
    .execute();
}

export async function loadGlobalLearning(db: Db, id: string): Promise<GlobalLearning | null> {
  const row = await db.selectFrom('global_learnings').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToGlobal(row) : null;
}

export async function listGlobalLearnings(db: Db, opts: { status?: LearningStatus } = {}): Promise<GlobalLearning[]> {
  let q = db.selectFrom('global_learnings').selectAll();
  if (opts.status) q = q.where('status', '=', opts.status);
  const rows = await q.orderBy('created_at', 'desc').limit(200).execute();
  return rows.map(rowToGlobal);
}

export async function listGlobalLearningsPage(
  db: Db,
  opts: { limit: number; offset: number; sort: string; dir: 'asc' | 'desc'; status?: string | undefined; q?: string | undefined },
): Promise<{ items: GlobalLearning[]; total: number }> {
  let base = db.selectFrom('global_learnings');
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
  return { items: rows.map(rowToGlobal), total: Number(totalRow?.n ?? 0) };
}

export async function loadApprovedGlobalLearnings(db: Db): Promise<GlobalLearning[]> {
  return listGlobalLearnings(db, { status: 'approved' });
}

// Tenant adoption of default global learnings (opt-in). Pending has no row; repeated decisions overwrite.

function rowToAdoption(row: {
  id: string;
  global_learning_id: string;
  status: string;
  scope: string;
  repository_ids: unknown;
  decided_by: string;
  decided_at: unknown;
}): GlobalLearningAdoption {
  return {
    id: row.id,
    globalLearningId: row.global_learning_id,
    status: row.status as GlobalLearningAdoption['status'],
    scope: row.scope as GlobalLearningAdoption['scope'],
    ...(Array.isArray(row.repository_ids) && row.repository_ids.length > 0 ? { repositoryIds: row.repository_ids as string[] } : {}),
    decidedBy: row.decided_by,
    decidedAt: (row.decided_at as Date).getTime(),
  };
}

/** Accept/decline; upserts so a decision can be changed or withdrawn. */
export async function upsertGlobalLearningAdoption(
  db: Db,
  tenantId: string,
  input: {
    globalLearningId: string;
    status: 'accepted' | 'declined';
    scope?: 'org' | 'repo';
    repositoryIds?: string[];
    decidedBy: string;
    now?: number;
  },
): Promise<void> {
  const at = new Date(input.now ?? Date.now());
  const scope = input.scope ?? 'org';
  const repositoryIds = scope === 'repo' ? (JSON.stringify(input.repositoryIds ?? []) as unknown as string[]) : null;
  await db
    .insertInto('global_learning_adoptions')
    .values({
      id: uuidv7(input.now),
      tenant_id: tenantId,
      global_learning_id: input.globalLearningId,
      status: input.status,
      scope,
      repository_ids: repositoryIds,
      decided_by: input.decidedBy,
      decided_at: at,
    })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'global_learning_id']).doUpdateSet({
        status: input.status,
        scope,
        repository_ids: repositoryIds,
        decided_by: input.decidedBy,
        decided_at: at,
      }),
    )
    .execute();
}

export async function loadGlobalLearningAdoptions(db: Db, tenantId: string): Promise<Map<string, GlobalLearningAdoption>> {
  const rows = await db.selectFrom('global_learning_adoptions').selectAll().where('tenant_id', '=', tenantId).execute();
  return new Map(rows.map((r) => [r.global_learning_id, rowToAdoption(r)]));
}

/** Unknown values are treated as 'prompt'. */
export async function loadGlobalLearningsPolicy(db: Db, tenantId: string): Promise<GlobalLearningsPolicy> {
  const row = await db.selectFrom('tenants').select('global_learnings_policy').where('id', '=', tenantId).executeTakeFirst();
  const v = row?.global_learnings_policy;
  return v === 'auto_accept' || v === 'ignore' ? v : 'prompt';
}

/**
 * Adoption inbox: approved default learnings without an adoption row; empty under policy=ignore.
 * Returns an allowlist of fields: source/deliberation/approver are operator-only (cross-tenant leak).
 */
export async function listPendingGlobalLearnings(
  db: Db,
  tenantId: string,
): Promise<Pick<GlobalLearning, 'id' | 'locality' | 'selector' | 'instruction' | 'rationale' | 'enforcement'>[]> {
  if ((await loadGlobalLearningsPolicy(db, tenantId)) === 'ignore') return [];
  const adoptions = await loadGlobalLearningAdoptions(db, tenantId);
  const approved = await loadApprovedGlobalLearnings(db);
  const now = Date.now();
  return approved
    .filter((g) => g.enforcement === 'default' && !adoptions.has(g.id))
    // Expired rules are no longer injected, so offering them for adoption would be a no-op.
    .filter((g) => g.expiresAt === undefined || g.expiresAt > now)
    .map((g) => ({
      id: g.id,
      locality: g.locality,
      ...(g.selector !== undefined ? { selector: g.selector } : {}),
      instruction: g.instruction,
      rationale: g.rationale,
      enforcement: g.enforcement,
    }));
}

/**
 * Mandatory always applies; an adoption row decides if present (declined never, accepted by scope);
 * otherwise the policy decides (only auto_accept applies).
 */
export function adoptionAllows(
  g: Pick<GlobalLearning, 'id' | 'enforcement'>,
  policy: GlobalLearningsPolicy,
  adoptions: ReadonlyMap<string, GlobalLearningAdoption>,
  repositoryId: string,
): boolean {
  if (g.enforcement === 'mandatory') return true;
  if (policy === 'ignore') return false;
  const a = adoptions.get(g.id);
  if (!a) return policy === 'auto_accept';
  if (a.status === 'declined') return false;
  return a.scope === 'org' || (a.repositoryIds ?? []).includes(repositoryId);
}

function normalizeInstruction(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Dedup for auto proposals. */
export async function globalLearningExists(db: Db, instruction: string): Promise<boolean> {
  const norm = normalizeInstruction(instruction);
  const rows = await db
    .selectFrom('global_learnings')
    .select('instruction')
    .where('status', 'in', ['proposed', 'approved'])
    .execute();
  return rows.some((r) => normalizeInstruction(r.instruction) === norm);
}

/** Adapts to a LearningProposal (broadness='global') to reuse transitionLearning's state machine and authz. */
function asProposal(g: GlobalLearning): LearningProposal {
  return {
    id: g.id,
    repositoryId: null,
    broadness: 'global',
    locality: g.locality,
    ...(g.selector !== undefined ? { selector: g.selector } : {}),
    enforcement: g.enforcement,
    instruction: g.instruction,
    rationale: g.rationale,
    proposedBy: g.proposedBy,
    status: g.status,
    ...(g.approvedBy !== undefined ? { approvedBy: g.approvedBy } : {}),
    version: g.version,
  };
}

/** Transition and persist; only platform operators may approve/reject/revoke (enforced by transitionLearning). */
export async function transitionGlobalLearning(
  db: Db,
  id: string,
  input: { action: 'approve' | 'reject' | 'revoke' | 'expire'; actor?: LearningActor; now?: number },
): Promise<LearningTransitionResult> {
  const g = await loadGlobalLearning(db, id);
  if (!g) return { ok: false, reason: 'global learning not found' };
  const result = transitionLearning(asProposal(g), input);
  if (result.ok && result.proposal) {
    const p = result.proposal;
    await db
      .updateTable('global_learnings')
      .set({
        status: p.status,
        version: p.version,
        approved_by: p.approvedBy ?? null,
        updated_at: new Date(input.now ?? Date.now()),
      })
      .where('id', '=', id)
      .execute();
  }
  return result;
}
