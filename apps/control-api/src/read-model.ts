import { ACTIVE_LIFECYCLES } from '@reviewbot/finding-lifecycle';
import { loadEffectiveConfig } from '@reviewbot/config';
import { sql, type Db } from '@reviewbot/db';
import { paged, type ListParams, type Paged } from './list-query.js';

/** Read-only console queries; every query is explicitly scoped by tenant. */

/** Allowlisted sort keys -> DB columns. */
type SortMap = Record<string, string>;
const col = (map: SortMap, sort: string, fallback: string): string => map[sort] ?? fallback;

export interface InstallationRow {
  id: string;
  accountLogin: string | null;
  status: string;
  createdAt: string;
}

export interface RepositoryRow {
  id: string;
  namespace: string;
  name: string;
  defaultBranch: string;
  forge: string;
  /** `repo-file` = `.winnowl.yaml` is authoritative; `panel` also covers repositories never configured. */
  configSource: 'panel' | 'repo-file';
  profile: string;
  mergeGate: boolean;
  reviews30d: number;
  lastReviewAt: string | null;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export const INSTALLATION_SORTS = ['createdAt', 'account', 'status'] as const;
export interface InstallationFilters {
  status?: string | undefined;
  q?: string | undefined;
}

export async function listInstallations(
  db: Db,
  tenantId: string,
  params: ListParams,
  filters: InstallationFilters = {},
): Promise<Paged<InstallationRow>> {
  let base = db.selectFrom('installations').where('tenant_id', '=', tenantId);
  if (filters.status) base = base.where('status', '=', filters.status);
  if (filters.q) base = base.where('account_login', 'ilike', `%${filters.q}%`);

  const totalRow = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const sortCol = col(
    { createdAt: 'created_at', account: 'account_login', status: 'status' },
    params.sort,
    'created_at',
  );
  const rows = await base
    .select(['id', 'account_login', 'status', 'created_at'])
    .orderBy(sortCol as 'created_at', params.dir)
    .orderBy('id', 'desc')
    .limit(params.limit)
    .offset(params.offset)
    .execute();
  const items = rows.map((r) => ({
    id: r.id,
    accountLogin: r.account_login,
    status: r.status,
    createdAt: iso(r.created_at),
  }));
  return paged(items, Number(totalRow?.n ?? 0), params);
}

export const REPOSITORY_SORTS = ['name', 'namespace', 'defaultBranch'] as const;
export interface RepositoryFilters {
  q?: string | undefined;
}

export async function listRepositories(
  db: Db,
  tenantId: string,
  params: ListParams,
  filters: RepositoryFilters = {},
): Promise<Paged<RepositoryRow>> {
  let base = db.selectFrom('repositories').where('tenant_id', '=', tenantId);
  if (filters.q)
    base = base.where((eb) =>
      eb.or([eb('namespace', 'ilike', `%${filters.q}%`), eb('name', 'ilike', `%${filters.q}%`)]),
    );

  const totalRow = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const sortCol = col(
    { name: 'name', namespace: 'namespace', defaultBranch: 'default_branch' },
    params.sort,
    'namespace',
  );
  let q = base
    .select(['id', 'namespace', 'name', 'default_branch', 'provider_host_id'])
    .orderBy(sortCol as 'name', params.dir);
  // Ties on namespace are broken by name for a stable order.
  if (sortCol === 'namespace') q = q.orderBy('name', params.dir);
  const rows = await q.orderBy('id', 'desc').limit(params.limit).offset(params.offset).execute();
  const facts = await repositoryFacts(
    db,
    tenantId,
    rows.map((r) => r.id),
    [...new Set(rows.map((r) => r.provider_host_id))],
  );
  const items = rows.map((r): RepositoryRow => {
    const settings = facts.settings.get(r.id);
    const reviews = facts.reviews.get(r.id);
    return {
      id: r.id,
      namespace: r.namespace,
      name: r.name,
      defaultBranch: r.default_branch,
      forge: facts.forges.get(r.provider_host_id) ?? '',
      configSource: settings?.source === 'repo-file' ? 'repo-file' : 'panel',
      profile: settings?.profile ?? 'balanced',
      mergeGate: settings?.mergeGate ?? false,
      reviews30d: reviews?.n ?? 0,
      lastReviewAt: reviews?.last ?? null,
    };
  });
  return paged(items, Number(totalRow?.n ?? 0), params);
}

async function repositoryFacts(db: Db, tenantId: string, ids: string[], hostIds: string[]) {
  const settings = new Map<string, { source: string; profile: string | null; mergeGate: boolean | null }>();
  const reviews = new Map<string, { n: number; last: string }>();
  const forges = new Map<string, string>();
  if (ids.length === 0) return { settings, reviews, forges };
  const [settingRows, reviewRows, hostRows] = await Promise.all([
    db
      .selectFrom('repository_settings')
      .select([
        'repository_id',
        'source',
        sql<string | null>`settings #>> '{reviews,profile}'`.as('profile'),
        sql<boolean | null>`(settings #>> '{merge_gate,enabled}')::boolean`.as('merge_gate'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('repository_id', 'in', ids)
      .execute(),
    db
      .selectFrom('review_costs')
      .select([
        'repository_id',
        sql<string>`count(*) filter (where created_at > now() - interval '30 days')`.as('n'),
        sql<Date>`max(created_at)`.as('last'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('repository_id', 'in', ids)
      .groupBy('repository_id')
      .execute(),
    db.selectFrom('provider_hosts').select(['id', 'provider']).where('id', 'in', hostIds).execute(),
  ]);
  for (const r of settingRows)
    settings.set(r.repository_id, { source: r.source, profile: r.profile, mergeGate: r.merge_gate });
  for (const r of reviewRows) reviews.set(r.repository_id, { n: Number(r.n), last: iso(r.last) });
  for (const r of hostRows) forges.set(r.id, r.provider);
  return { settings, reviews, forges };
}

export interface UsageSummary {
  totals: { reviews: number; totalTokens: number; costUsd: number };
  byRepository: { repository: string; reviews: number; totalTokens: number; costUsd: number }[];
}

/** Gross review spend since `since` (BYOK and public-repo discounts are not applied here). */
export async function getUsageSummary(db: Db, tenantId: string, since: Date): Promise<UsageSummary> {
  const rows = await db
    .selectFrom('review_costs as c')
    .innerJoin('repositories as repo', 'repo.id', 'c.repository_id')
    .select((eb) => [
      'repo.namespace as ns',
      'repo.name as name',
      eb.fn.countAll<string>().as('reviews'),
      eb.fn.sum<string>('c.total_tokens').as('totalTokens'),
      eb.fn.sum<string>('c.cost_usd').as('costUsd'),
    ])
    .where('c.tenant_id', '=', tenantId)
    .where('repo.tenant_id', '=', tenantId)
    .where('c.created_at', '>=', since)
    .groupBy(['repo.id', 'repo.namespace', 'repo.name'])
    .orderBy('costUsd', 'desc')
    .execute();
  const byRepository = rows.map((r) => ({
    repository: `${r.ns}/${r.name}`,
    reviews: Number(r.reviews),
    totalTokens: Number(r.totalTokens ?? 0),
    costUsd: Number(r.costUsd ?? 0),
  }));
  const totals = byRepository.reduce(
    (t, r) => ({ reviews: t.reviews + r.reviews, totalTokens: t.totalTokens + r.totalTokens, costUsd: t.costUsd + r.costUsd }),
    { reviews: 0, totalTokens: 0, costUsd: 0 },
  );
  return { totals, byRepository };
}

export interface RepositoryConfigView {
  repositoryId: string;
  repository: string;
  settings: Record<string, unknown>;
  configDigest: string | null;
  /** panel | repo-file; with repo-file the repo yaml wins and panel edits are overwritten by the next review. */
  source: string;
  updatedAt: string | null;
}

export async function getRepositoryConfig(
  db: Db,
  tenantId: string,
  repositoryId: string,
): Promise<RepositoryConfigView | null> {
  const row = await db
    .selectFrom('repositories as r')
    .leftJoin('repository_settings as s', 's.repository_id', 'r.id')
    .select(['r.namespace', 'r.name', 's.config_digest', 's.source', 's.updated_at'])
    .where('r.tenant_id', '=', tenantId)
    .where('r.id', '=', repositoryId)
    .executeTakeFirst();
  if (!row) return null;
  // Resolved like every other reader (organization defaults included); a never-reviewed repository gets those.
  return {
    repositoryId,
    repository: `${row.namespace}/${row.name}`,
    settings: (await loadEffectiveConfig(db, tenantId, repositoryId)) as unknown as Record<string, unknown>,
    configDigest: row.config_digest,
    source: row.source ?? 'panel',
    updatedAt: row.updated_at ? iso(row.updated_at) : null,
  };
}

export interface RunnerWorkerRow {
  id: string;
  pool: string;
  mode: string;
  version: string;
  runningJobs: number;
  maxConcurrency: number;
  lastHeartbeatAt: string;
}

export interface RunnersView {
  items: RunnerWorkerRow[];
  total: number;
  limit: number;
  offset: number;
  queuedJobs: number;
  runningJobs: number;
}

/** One row per worker (pool is a column); pools without workers are omitted. */
export async function getRunners(
  db: Db,
  tenantId: string,
  opts: { allTenants?: boolean; limit?: number; offset?: number } = {},
): Promise<RunnersView> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  // Shared pools (tenant_id IS NULL) are operator-only; tenants see their own pools, and job counts are always tenant-scoped.
  let rowsQuery = db
    .selectFrom('workers')
    .innerJoin('runner_pools', 'runner_pools.id', 'workers.pool_id')
    .select([
      'workers.id as id',
      'workers.mode as mode',
      'workers.version as version',
      'workers.running_jobs as running_jobs',
      'workers.max_concurrency as max_concurrency',
      'workers.last_heartbeat_at as last_heartbeat_at',
      'runner_pools.name as pool_name',
    ]);
  let totalQuery = db
    .selectFrom('workers')
    .innerJoin('runner_pools', 'runner_pools.id', 'workers.pool_id')
    .select((eb) => eb.fn.countAll<string>().as('n'));
  if (!opts.allTenants) {
    rowsQuery = rowsQuery.where('runner_pools.tenant_id', '=', tenantId);
    totalQuery = totalQuery.where('runner_pools.tenant_id', '=', tenantId);
  }

  const rows = await rowsQuery
    .orderBy('workers.last_heartbeat_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute();

  const totalRow = await totalQuery.executeTakeFirst();

  let queuedQuery = db
    .selectFrom('jobs')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('status', '=', 'queued');
  let runningQuery = db
    .selectFrom('jobs')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('status', 'in', ['leased', 'running']);
  if (!opts.allTenants) {
    queuedQuery = queuedQuery.where('tenant_id', '=', tenantId);
    runningQuery = runningQuery.where('tenant_id', '=', tenantId);
  }
  const [queued, running] = await Promise.all([
    queuedQuery.executeTakeFirst(),
    runningQuery.executeTakeFirst(),
  ]);

  return {
    items: rows.map((w) => ({
      id: w.id,
      pool: w.pool_name,
      mode: w.mode,
      version: w.version,
      runningJobs: w.running_jobs,
      maxConcurrency: w.max_concurrency,
      lastHeartbeatAt: new Date(w.last_heartbeat_at).toISOString(),
    })),
    total: Number(totalRow?.n ?? 0),
    limit,
    offset,
    queuedJobs: Number(queued?.n ?? 0),
    runningJobs: Number(running?.n ?? 0),
  };
}

export interface DashboardSummary {
  /** Start of the 30-day window. */
  since: string;
  reviews: number;
  activeRepositories: number;
  /**
   * Per review run, so each stage is a subset of the previous one: candidates proposed, verified
   * (independently), published (inline or in the summary), and published ones whose finding is now resolved.
   */
  funnel: { candidates: number; verified: number; published: number; fixed: number };
  /** Unresolved findings by their highest severity. */
  openBySeverity: { severity: string; count: number }[];
  recentPublished: {
    findingId: string;
    claim: string;
    severity: string;
    path: string | null;
    line: number | null;
    repository: string;
    changeNumber: number;
    revisionId: string;
    createdAt: string;
  }[];
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const severityRank = (s: string): number => (SEVERITY_ORDER.includes(s) ? SEVERITY_ORDER.indexOf(s) : SEVERITY_ORDER.length);

export async function getDashboardSummary(
  db: Db,
  tenantId: string,
  now: number = Date.now(),
): Promise<DashboardSummary> {
  const since = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const cost = await db
    .selectFrom('review_costs as cost')
    .innerJoin('repositories as repo', 'repo.id', 'cost.repository_id')
    .select((eb) => [
      eb.fn.countAll<string>().as('reviews'),
      eb.fn.sum<string>('cost.candidate_count').as('candidates'),
      eb.fn.count<string>('cost.repository_id').distinct().as('repos'),
    ])
    .where('cost.tenant_id', '=', tenantId)
    .where('repo.tenant_id', '=', tenantId)
    .where('cost.created_at', '>=', since)
    .executeTakeFirst();
  const stages = await db
    .selectFrom('finding_occurrences as fo')
    .innerJoin('findings as f', 'f.id', 'fo.finding_id')
    .select((eb) => [
      eb.fn.countAll<string>().as('verified'),
      eb.fn.count<string>(eb.case().when('fo.state', 'in', ['inline', 'summary']).then(1).end()).as('published'),
      eb.fn
        .count<string>(
          eb
            .case()
            .when(eb.and([eb('fo.state', 'in', ['inline', 'summary']), eb('f.lifecycle', '=', 'resolved')]))
            .then(1)
            .end(),
        )
        .as('fixed'),
    ])
    .where('fo.tenant_id', '=', tenantId)
    .where('f.tenant_id', '=', tenantId)
    .where('fo.confirmation', '=', 'independently-verified')
    .where('fo.created_at', '>=', since)
    .executeTakeFirst();
  const open = await db
    .selectFrom('findings as f')
    .innerJoin('finding_occurrences as fo', 'fo.finding_id', 'f.id')
    .select(['f.id as id', 'fo.severity as severity'])
    .where('f.tenant_id', '=', tenantId)
    .where('fo.tenant_id', '=', tenantId)
    .where('f.lifecycle', 'in', ACTIVE_LIFECYCLES)
    .where('fo.state', 'in', ['inline', 'summary'])
    .execute();
  const worst = new Map<string, string>();
  for (const r of open) {
    const cur = worst.get(r.id);
    if (cur === undefined || severityRank(r.severity) < severityRank(cur)) worst.set(r.id, r.severity);
  }
  const bySeverity = new Map<string, number>();
  for (const sev of worst.values()) bySeverity.set(sev, (bySeverity.get(sev) ?? 0) + 1);
  const recent = await db
    .selectFrom('finding_occurrences as fo')
    .innerJoin('findings as f', 'f.id', 'fo.finding_id')
    .innerJoin('revisions as rev', (join) =>
      join.onRef('rev.id', '=', 'fo.revision_id').onRef('rev.tenant_id', '=', 'fo.tenant_id'),
    )
    .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
    .innerJoin('repositories as repo', 'repo.id', 'cr.repository_id')
    .select([
      'f.id as findingId',
      'f.canonical_claim as claim',
      'fo.severity as severity',
      'fo.anchor as anchor',
      'fo.created_at as createdAt',
      'rev.id as revisionId',
      'cr.number as changeNumber',
      'repo.namespace as ns',
      'repo.name as name',
    ])
    .where('fo.tenant_id', '=', tenantId)
    .where('f.tenant_id', '=', tenantId)
    .where('rev.tenant_id', '=', tenantId)
    .where('cr.tenant_id', '=', tenantId)
    .where('repo.tenant_id', '=', tenantId)
    .where('fo.state', 'in', ['inline', 'summary'])
    .where('f.lifecycle', 'in', ACTIVE_LIFECYCLES)
    .orderBy('fo.created_at', 'desc')
    .limit(20)
    .execute();
  const seen = new Set<string>();
  const recentPublished = recent
    .filter((r) => (seen.has(r.findingId) ? false : (seen.add(r.findingId), true)))
    .slice(0, 5)
    .map((r) => {
      const anchor = (r.anchor ?? {}) as { path?: unknown; line?: unknown };
      return {
        findingId: r.findingId,
        claim: r.claim,
        severity: r.severity,
        path: typeof anchor.path === 'string' ? anchor.path : null,
        line: typeof anchor.line === 'number' ? anchor.line : null,
        repository: `${r.ns}/${r.name}`,
        changeNumber: r.changeNumber,
        revisionId: r.revisionId,
        createdAt: r.createdAt.toISOString(),
      };
    });

  return {
    since: since.toISOString(),
    reviews: Number(cost?.reviews ?? 0),
    activeRepositories: Number(cost?.repos ?? 0),
    funnel: {
      candidates: Number(cost?.candidates ?? 0),
      verified: Number(stages?.verified ?? 0),
      published: Number(stages?.published ?? 0),
      fixed: Number(stages?.fixed ?? 0),
    },
    openBySeverity: [...bySeverity]
      .map(([severity, count]) => ({ severity, count }))
      .sort((x, y) => severityRank(x.severity) - severityRank(y.severity)),
    recentPublished,
  };
}

/** Must match the value range of `STEP_INDEX_OF`. Internal stage names never reach the frontend. */
export const REVIEW_STEP_COUNT = 6;

export type ReviewOutcome = 'done' | 'failed' | 'superseded';

/**
 * Internal stage -> 0-based step. Indices are positional, so responses include `stepCount` and the
 * frontend hides the step bar when its label count differs.
 */
const STEP_INDEX_OF: Record<string, number> = {
  prepare: 0,
  map: 1,
  dig: 2,
  synthesis: 3,
  verify: 4,
  publish: 5,
};

export function reviewStepOf(stage: string): number | null {
  return STEP_INDEX_OF[stage] ?? null;
}

const OUTCOME_OF: Record<string, ReviewOutcome> = {
  done: 'done',
  failed: 'failed',
  cancelled: 'superseded',
};

/** `areas` counts changed areas, `findings` counts findings to verify; null = nothing countable. */
export type ReviewCountKind = 'areas' | 'findings' | null;

const COUNT_OF: Record<number, Exclude<ReviewCountKind, null>> = { 2: 'areas', 4: 'findings' };

export function reviewCountKind(stepIndex: number | null, done: number | null, total: number | null): ReviewCountKind {
  return stepIndex !== null && done !== null && total !== null && total > 0 ? (COUNT_OF[stepIndex] ?? null) : null;
}

/** Cross-tenant (operator) callers run this inside `runWithoutTenant`; access is checked by the route. */
export interface ReviewProgressRow {
  jobId: string;
  repository: string;
  changeNumber: number;
  sourceBranch: string | null;
  targetBranch: string | null;
  /** 0-based; null when finished or the stage is unknown. */
  stepIndex: number | null;
  stepCount: number;
  countKind: ReviewCountKind;
  done: number | null;
  total: number | null;
  attempt: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  outcome: ReviewOutcome | null;
  /** Operator view only. */
  tenantName?: string;
}

export async function listReviewProgress(
  db: Db,
  opts: { tenantId?: string; includeFinishedWithinMs?: number },
): Promise<{ items: ReviewProgressRow[] }> {
  // Keep just-finished runs visible briefly.
  const cutoff = new Date(Date.now() - (opts.includeFinishedWithinMs ?? 5 * 60_000));
  let q = db
    .selectFrom('review_progress as p')
    .innerJoin('repositories as r', (join) =>
      join.onRef('r.id', '=', 'p.repository_id').onRef('r.tenant_id', '=', 'p.tenant_id'),
    )
    .innerJoin('change_requests as c', (join) =>
      join.onRef('c.id', '=', 'p.change_request_id').onRef('c.tenant_id', '=', 'p.tenant_id'),
    )
    .innerJoin('tenants as t', 't.id', 'p.tenant_id')
    .select([
      'p.job_id as jobId',
      'p.stage as stage',
      'p.done as done',
      'p.total as total',
      'p.attempt as attempt',
      'p.started_at as startedAt',
      'p.updated_at as updatedAt',
      'p.finished_at as finishedAt',
      'r.namespace as namespace',
      'r.name as repoName',
      'c.number as changeNumber',
      'c.source_branch as sourceBranch',
      'c.target_branch as targetBranch',
      't.name as tenantName',
    ])
    .where((eb) => eb.or([eb('p.finished_at', 'is', null), eb('p.finished_at', '>', cutoff)]))
    .orderBy(sql`case when p.finished_at is null then 0 else 1 end`)
    .orderBy('p.updated_at', 'desc')
    .limit(50);
  if (opts.tenantId) q = q.where('p.tenant_id', '=', opts.tenantId);
  const rows = await q.execute();
  return {
    items: rows.map((r) => {
      const stepIndex = STEP_INDEX_OF[r.stage] ?? null;
      return {
        jobId: r.jobId,
        repository: `${r.namespace}/${r.repoName}`,
        changeNumber: r.changeNumber,
        sourceBranch: r.sourceBranch,
        targetBranch: r.targetBranch,
        stepIndex,
        stepCount: REVIEW_STEP_COUNT,
        outcome: OUTCOME_OF[r.stage] ?? null,
        countKind: reviewCountKind(stepIndex, r.done, r.total),
        done: r.done,
        total: r.total,
        attempt: r.attempt,
        startedAt: (r.startedAt as Date).toISOString(),
        updatedAt: (r.updatedAt as Date).toISOString(),
        finishedAt: r.finishedAt ? (r.finishedAt as Date).toISOString() : null,
        ...(opts.tenantId ? {} : { tenantName: r.tenantName }),
      };
    }),
  };
}
