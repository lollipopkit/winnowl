import { sql, type Db } from '@reviewbot/db';
import { isLearningActive, listLearningProposals, loadGlobalLearningAdoptions, loadGlobalLearningsPolicy } from '@reviewbot/knowledge';

export type RuleScope = 'repository' | 'organization' | 'user' | 'platform';
/** active = injected into reviews; proposed = waiting for a decision; inactive = neither. */
export type RuleState = 'active' | 'proposed' | 'inactive';

export interface RuleRow {
  id: string;
  scope: RuleScope;
  /** Repository rules; or the repositories a platform rule was adopted for. */
  repositories: string[];
  instruction: string;
  rationale: string;
  selector: string | null;
  /** Tenant: proposed | approved | rejected | revoked | expired. Platform: mandatory | adopted | recommended | declined | ignored. */
  status: string;
  state: RuleState;
  createdAt: string;
  expiresAt: string | null;
  /** Reviews that injected it; platform rules are not counted. */
  usageCount: number | null;
}

export interface RuleFilters {
  scope?: string | undefined;
  state?: string | undefined;
  q?: string | undefined;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** Tenant rules and the platform rules visible to the tenant, as one list; platform rows carry tenant-safe fields only. */
export async function listRules(
  db: Db,
  tenantId: string,
  page: { limit: number; offset: number },
  filters: RuleFilters = {},
): Promise<{ items: RuleRow[]; total: number; limit: number; offset: number; counts: Record<'all' | RuleScope, number> }> {
  const [tenantRules, globals, policy, adoptions, repos] = await Promise.all([
    listLearningProposals(db, tenantId),
    db
      .selectFrom('global_learnings')
      .select(['id', 'selector', 'instruction', 'rationale', 'enforcement', 'created_at', 'expires_at'])
      .where('status', '=', 'approved')
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
      .execute(),
    loadGlobalLearningsPolicy(db, tenantId),
    loadGlobalLearningAdoptions(db, tenantId),
    db.selectFrom('repositories').select(['id', 'namespace', 'name']).where('tenant_id', '=', tenantId).execute(),
  ]);
  const repoName = new Map(repos.map((r) => [r.id, `${r.namespace}/${r.name}`]));
  const names = (ids: string[]): string[] => ids.map((id) => repoName.get(id)).filter((n): n is string => n !== undefined);

  const rows: RuleRow[] = tenantRules
    .filter((p) => p.broadness !== 'global')
    .map((p) => {
      const status = p.status === 'approved' && !isLearningActive(p) ? 'expired' : p.status;
      return {
        id: p.id,
        scope: p.broadness as Exclude<RuleScope, 'platform'>,
        repositories: p.repositoryId ? names([p.repositoryId]) : [],
        instruction: p.instruction,
        rationale: p.rationale,
        selector: p.selector ?? null,
        status,
        state: status === 'approved' ? 'active' : status === 'proposed' ? 'proposed' : 'inactive',
        createdAt: new Date(p.createdAt ?? 0).toISOString(),
        expiresAt: p.expiresAt !== undefined ? new Date(p.expiresAt).toISOString() : null,
        usageCount: p.usageCount ?? 0,
      };
    });

  for (const g of globals) {
    const a = adoptions.get(g.id);
    const status =
      g.enforcement === 'mandatory'
        ? 'mandatory'
        : policy === 'ignore'
          ? 'ignored'
          : a?.status === 'declined'
            ? 'declined'
            : a || policy === 'auto_accept'
              ? 'adopted'
              : 'recommended';
    rows.push({
      id: g.id,
      scope: 'platform',
      repositories: a?.status === 'accepted' && a.scope === 'repo' ? names(a.repositoryIds ?? []) : [],
      instruction: g.instruction,
      rationale: g.rationale,
      selector: g.selector,
      status,
      state: status === 'mandatory' || status === 'adopted' ? 'active' : status === 'recommended' ? 'proposed' : 'inactive',
      createdAt: iso(g.created_at),
      expiresAt: g.expires_at ? iso(g.expires_at) : null,
      usageCount: null,
    });
  }

  const q = filters.q?.toLowerCase();
  const matching = rows.filter(
    (r) =>
      (!filters.state || r.state === filters.state) &&
      (!q || r.instruction.toLowerCase().includes(q) || r.repositories.some((n) => n.toLowerCase().includes(q))),
  );
  const counts = { all: matching.length, repository: 0, organization: 0, user: 0, platform: 0 };
  for (const r of matching) counts[r.scope] += 1;
  const scoped = filters.scope ? matching.filter((r) => r.scope === filters.scope) : matching;
  // Pending decisions first, then newest.
  const order: Record<RuleState, number> = { proposed: 0, active: 1, inactive: 2 };
  scoped.sort((a, b) => order[a.state] - order[b.state] || b.createdAt.localeCompare(a.createdAt));
  return {
    items: scoped.slice(page.offset, page.offset + page.limit),
    total: scoped.length,
    limit: page.limit,
    offset: page.offset,
    counts,
  };
}
