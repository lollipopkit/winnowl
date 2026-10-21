import { runWithoutTenant, type Db } from '@reviewbot/db';
import type { PanelVote } from './types.js';

// Cross-tenant platform aggregates used as proposer evidence. Returns aggregates only (claim/class +
// counts), never raw private code or text. For platform system jobs only, not tenant requests.

export interface RecurringFinding {
  claim: string;
  category: string;
  occurrences: number;
  /** Distinct tenants (cross-tenant recurrence, used for global). */
  tenants: number;
  /** Distinct repositories (used to choose repo vs org broadness). */
  repos: number;
}

/** Top-N recurring finding claims. Without tenantId it spans all tenants; with it, one tenant only. */
export async function aggregateRecurringFindings(
  db: Db,
  opts: { category?: string; limit?: number; tenantId?: string } = {},
): Promise<RecurringFinding[]> {
  let q = db
    .selectFrom('findings')
    .select((eb) => [
      'canonical_claim as claim',
      'category',
      eb.fn.countAll<number>().as('occurrences'),
      eb.fn.count<number>('tenant_id').distinct().as('tenants'),
      eb.fn.count<number>('repository_id').distinct().as('repos'),
    ])
    .groupBy(['canonical_claim', 'category']);
  if (opts.category) q = q.where('category', '=', opts.category);
  if (opts.tenantId) q = q.where('tenant_id', '=', opts.tenantId);
  const run = q.orderBy('occurrences', 'desc').limit(opts.limit ?? 20);
  // Intentional cross-tenant read when tenantId is absent (global proposer); only counts and canonical claims leave.
  const rows = opts.tenantId ? await run.execute() : await runWithoutTenant(() => run.execute());
  return rows.map((r) => ({ claim: r.claim, category: r.category, occurrences: Number(r.occurrences), tenants: Number(r.tenants), repos: Number(r.repos) }));
}

export interface RecurringFeedback {
  class: string;
  occurrences: number;
  tenants: number;
  repos: number;
}

/** Top-N recurring feedback classes; limited to one tenant when tenantId is given. */
export async function aggregateRecurringFeedback(db: Db, opts: { limit?: number; tenantId?: string } = {}): Promise<RecurringFeedback[]> {
  let q = db
    .selectFrom('feedbacks')
    .select((eb) => [
      'class',
      eb.fn.countAll<number>().as('occurrences'),
      eb.fn.count<number>('tenant_id').distinct().as('tenants'),
      eb.fn.count<number>('repository_id').distinct().as('repos'),
    ])
    .groupBy('class');
  if (opts.tenantId) q = q.where('tenant_id', '=', opts.tenantId);
  const run = q.orderBy('occurrences', 'desc').limit(opts.limit ?? 20);
  // Cross-tenant only for the global proposer (no tenantId).
  const rows = opts.tenantId ? await run.execute() : await runWithoutTenant(() => run.execute());
  return rows.map((r) => ({ class: r.class, occurrences: Number(r.occurrences), tenants: Number(r.tenants), repos: Number(r.repos) }));
}

export interface CrossTenantLearning {
  instruction: string;
  /** Distinct tenants that approved it; >= 2 makes it a global candidate. */
  tenants: number;
}

/** Instructions approved by several tenants (global candidates), top N. */
export async function aggregateCrossTenantLearnings(db: Db, opts: { limit?: number } = {}): Promise<CrossTenantLearning[]> {
  // Inherently cross-tenant; only normalised instructions and counts leave.
  const rows = await runWithoutTenant(() => db
    .selectFrom('learning_proposals')
    .select((eb) => ['instruction', eb.fn.count<number>('tenant_id').distinct().as('tenants')])
    .where('status', '=', 'approved')
    .groupBy('instruction')
    .having((eb) => eb.fn.count<number>('tenant_id').distinct(), '>=', 2)
    .orderBy('tenants', 'desc')
    .limit(opts.limit ?? 20)
    .execute());
  return rows.map((r) => ({ instruction: r.instruction, tenants: Number(r.tenants) }));
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Panel confidence = approval rate x mean confidence of approve votes. */
export function aggregatePanel(votes: PanelVote[]): { confidence: number; approvals: number; total: number } {
  const total = votes.length;
  if (total === 0) return { confidence: 0, approvals: 0, total: 0 };
  const approve = votes.filter((v) => v.decision === 'approve');
  const approvals = approve.length;
  const approveConfAvg = approvals > 0 ? approve.reduce((s, v) => s + clamp01(v.confidence), 0) / approvals : 0;
  const confidence = (approvals / total) * approveConfAvg;
  return { confidence: Math.round(confidence * 1000) / 1000, approvals, total };
}
