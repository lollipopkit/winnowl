import { sql, type Db } from '@reviewbot/db';
import { paged, type ListParams, type Paged } from './list-query.js';

export const AUDIT_SORTS = ['createdAt', 'action', 'actor'] as const;

export type AuditTargetKind = 'finding' | 'repository' | 'review' | 'action-plan' | 'rule';

export interface AuditRow {
  id: string;
  actor: string | null;
  /** Member name for console actors; null for system actors or ids that are not members. */
  actorLabel: string | null;
  action: string;
  target: string | null;
  targetKind: AuditTargetKind | null;
  targetLabel: string | null;
  createdAt: string;
}

export interface AuditFilters {
  action?: string | undefined;
  actor?: string | undefined;
  q?: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export async function listAudit(
  db: Db,
  tenantId: string,
  params: ListParams,
  filters: AuditFilters = {},
): Promise<Paged<AuditRow>> {
  let base = db.selectFrom('audit_events').where('tenant_id', '=', tenantId);
  if (filters.action) base = base.where('action', '=', filters.action);
  if (filters.actor) base = base.where('actor', '=', filters.actor);
  if (filters.q)
    base = base.where((eb) => eb.or([eb('actor', 'ilike', `%${filters.q}%`), eb('target', 'ilike', `%${filters.q}%`)]));

  const totalRow = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const sortCol = params.sort === 'action' ? 'action' : params.sort === 'actor' ? 'actor' : 'created_at';
  const rows = await base
    .select(['id', 'actor', 'action', 'target', 'created_at'])
    .orderBy(sortCol, params.dir)
    .orderBy('id', 'desc')
    .limit(params.limit)
    .offset(params.offset)
    .execute();
  const [actors, targets] = await Promise.all([
    actorLabels(db, tenantId, rows.map((r) => r.actor)),
    resolveTargets(db, tenantId, rows.map((r) => r.target)),
  ]);
  const items = rows.map((r) => {
    const t = r.target ? targets.get(r.target) : undefined;
    return {
      id: r.id,
      actor: r.actor,
      actorLabel: (r.actor && actors.get(r.actor)) ?? null,
      action: r.action,
      target: r.target,
      targetKind: t?.kind ?? null,
      targetLabel: t?.label ?? null,
      createdAt: iso(r.created_at),
    };
  });
  return paged(items, Number(totalRow?.n ?? 0), params);
}

/** Filter options: the tenant's distinct actions and actors, most frequent first. */
export async function auditFacets(
  db: Db,
  tenantId: string,
): Promise<{ actions: string[]; actors: { id: string; label: string | null }[] }> {
  const [actions, actorRows] = await Promise.all([
    db
      .selectFrom('audit_events')
      .select('action')
      .where('tenant_id', '=', tenantId)
      .groupBy('action')
      .orderBy(sql`count(*)`, 'desc')
      .limit(200)
      .execute(),
    db
      .selectFrom('audit_events')
      .select('actor')
      .where('tenant_id', '=', tenantId)
      .where('actor', 'is not', null)
      .groupBy('actor')
      .orderBy(sql`count(*)`, 'desc')
      .limit(200)
      .execute(),
  ]);
  const ids = actorRows.map((r) => r.actor!);
  const labels = await actorLabels(db, tenantId, ids);
  return { actions: actions.map((a) => a.action), actors: ids.map((id) => ({ id, label: labels.get(id) ?? null })) };
}

/** Actors are identity subjects; only this tenant's members are named. */
async function actorLabels(db: Db, tenantId: string, actors: (string | null)[]): Promise<Map<string, string>> {
  const subjects = [...new Set(actors.filter((a): a is string => !!a))];
  if (subjects.length === 0) return new Map();
  const rows = await db
    .selectFrom('user_identities as i')
    .innerJoin('users as u', 'u.id', 'i.user_id')
    .innerJoin('memberships as m', 'm.user_id', 'u.id')
    .select(['i.subject', 'i.login', 'u.email', 'u.display_name'])
    .where('m.tenant_id', '=', tenantId)
    .where('i.subject', 'in', subjects)
    .execute();
  return new Map(rows.map((r) => [r.subject, r.display_name ?? r.login ?? r.email]));
}

async function resolveTargets(
  db: Db,
  tenantId: string,
  targets: (string | null)[],
): Promise<Map<string, { kind: AuditTargetKind; label: string }>> {
  const ids = [...new Set(targets.filter((t): t is string => !!t && UUID.test(t)))];
  const out = new Map<string, { kind: AuditTargetKind; label: string }>();
  if (ids.length === 0) return out;
  const [findings, repos, reviews, plans, rules] = await Promise.all([
    db.selectFrom('findings').select(['id', 'canonical_claim']).where('tenant_id', '=', tenantId).where('id', 'in', ids).execute(),
    db.selectFrom('repositories').select(['id', 'namespace', 'name']).where('tenant_id', '=', tenantId).where('id', 'in', ids).execute(),
    db
      .selectFrom('revisions as r')
      .innerJoin('change_requests as cr', 'cr.id', 'r.change_request_id')
      .innerJoin('repositories as repo', 'repo.id', 'cr.repository_id')
      .select(['r.id', 'cr.number', 'repo.name'])
      .where('r.tenant_id', '=', tenantId)
      .where('r.id', 'in', ids)
      .execute(),
    db.selectFrom('action_plans').select(['id']).where('tenant_id', '=', tenantId).where('id', 'in', ids).execute(),
    db.selectFrom('learning_proposals').select(['id', 'instruction']).where('tenant_id', '=', tenantId).where('id', 'in', ids).execute(),
  ]);
  for (const f of findings) out.set(f.id, { kind: 'finding', label: f.canonical_claim });
  for (const r of repos) out.set(r.id, { kind: 'repository', label: `${r.namespace}/${r.name}` });
  for (const r of reviews) out.set(r.id, { kind: 'review', label: `${r.name} #${r.number}` });
  for (const p of plans) out.set(p.id, { kind: 'action-plan', label: p.id.slice(0, 8) });
  for (const l of rules) out.set(l.id, { kind: 'rule', label: l.instruction });
  return out;
}
