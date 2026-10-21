import { ACTIVE_LIFECYCLES } from '@reviewbot/finding-lifecycle';
import { sql, type Db } from '@reviewbot/db';
import { paged, type ListParams, type Paged } from './list-query.js';
import { REVIEW_STEP_COUNT, reviewCountKind, reviewStepOf, type ReviewCountKind } from './read-model.js';

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const severityRank = (s: string): number => (SEVERITIES.includes(s) ? SEVERITIES.indexOf(s) : SEVERITIES.length);
const worstSeverity = (list: string[]): string | null =>
  list.length ? list.reduce((a, b) => (severityRank(b) < severityRank(a) ? b : a)) : null;

const PUBLISHED_STATES = ['inline', 'summary'];
const RISK_STATES = ['low-evidence', 'unverified-risks'];

export type ReviewRunState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ReviewRunProgress {
  jobId: string;
  stepIndex: number | null;
  stepCount: number;
  countKind: ReviewCountKind;
  done: number | null;
  total: number | null;
  startedAt: string;
}

export interface ReviewRunRow {
  revisionId: string;
  headSha: string;
  createdAt: string;
  repository: string;
  repositoryId: string;
  changeNumber: number;
  changeKind: string;
  title: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  state: ReviewRunState;
  progress: ReviewRunProgress | null;
  candidates: number | null;
  verified: number;
  published: number;
  topSeverity: string | null;
  gate: 'pass' | 'block' | null;
  blockingCount: number | null;
  costUsd: number | null;
}

export const REVIEW_SORTS = ['createdAt', 'change', 'repository'] as const;
export interface ReviewFilters {
  repositoryId?: string | undefined;
  /** running | blocked | failed */
  status?: string | undefined;
}

function stateOf(stage: string | undefined, finishedAt: unknown): ReviewRunState {
  if (stage === undefined) return 'pending';
  if (stage === 'done') return 'done';
  if (stage === 'failed') return 'failed';
  if (stage === 'cancelled') return 'cancelled';
  return finishedAt ? 'done' : 'running';
}

const latestStage = sql<string>`(select p.stage from review_progress p where p.revision_id = rev.id and p.tenant_id = rev.tenant_id order by p.started_at desc limit 1)`;
const latestFinished = sql<
  Date | null
>`(select p.finished_at from review_progress p where p.revision_id = rev.id and p.tenant_id = rev.tenant_id order by p.started_at desc limit 1)`;

/** Per-revision aggregates for the given revisions. */
async function runFacts(db: Db, tenantId: string, revisionIds: string[]) {
  if (revisionIds.length === 0) {
    return { progress: new Map(), costs: new Map(), occ: new Map() } as const;
  }
  const [progressRows, costRows, occRows] = await Promise.all([
    db
      .selectFrom('review_progress')
      .select(['job_id', 'revision_id', 'stage', 'done', 'total', 'started_at', 'finished_at'])
      .where('tenant_id', '=', tenantId)
      .where('revision_id', 'in', revisionIds)
      .orderBy('started_at', 'desc')
      .execute(),
    db
      .selectFrom('review_costs')
      .select(['revision_id', 'cost_usd', 'candidate_count', 'scopes_total', 'scopes_complete', 'created_at'])
      .where('tenant_id', '=', tenantId)
      .where('revision_id', 'in', revisionIds)
      .orderBy('created_at', 'desc')
      .execute(),
    db
      .selectFrom('finding_occurrences')
      .select(['revision_id', 'state', 'severity', 'confirmation'])
      .where('tenant_id', '=', tenantId)
      .where('revision_id', 'in', revisionIds)
      .execute(),
  ]);
  const progress = new Map<string, (typeof progressRows)[number]>();
  for (const p of progressRows) if (!progress.has(p.revision_id)) progress.set(p.revision_id, p);
  const costs = new Map<string, { costUsd: number; candidates: number; scopesTotal: number; scopesComplete: number }>();
  for (const c of costRows) {
    const prev = costs.get(c.revision_id);
    // Cost sums every run of the revision; counts come from the latest run.
    if (prev) prev.costUsd += Number(c.cost_usd);
    else
      costs.set(c.revision_id, {
        costUsd: Number(c.cost_usd),
        candidates: c.candidate_count,
        scopesTotal: c.scopes_total,
        scopesComplete: c.scopes_complete,
      });
  }
  const occ = new Map<string, { verified: number; published: number; severities: string[] }>();
  for (const o of occRows) {
    const agg = occ.get(o.revision_id) ?? { verified: 0, published: 0, severities: [] };
    if (o.confirmation === 'independently-verified') agg.verified += 1;
    if (PUBLISHED_STATES.includes(o.state)) {
      agg.published += 1;
      agg.severities.push(o.severity);
    }
    occ.set(o.revision_id, agg);
  }
  return { progress, costs, occ } as const;
}

function progressView(p: { job_id: string; stage: string; done: number | null; total: number | null; started_at: unknown }): ReviewRunProgress {
  const stepIndex = reviewStepOf(p.stage);
  return {
    jobId: p.job_id,
    stepIndex,
    stepCount: REVIEW_STEP_COUNT,
    countKind: reviewCountKind(stepIndex, p.done, p.total),
    done: p.done,
    total: p.total,
    startedAt: iso(p.started_at),
  };
}

export async function listReviewRuns(
  db: Db,
  tenantId: string,
  params: ListParams,
  filters: ReviewFilters = {},
): Promise<Paged<ReviewRunRow>> {
  let base = db
    .selectFrom('revisions as rev')
    .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
    .innerJoin('repositories as repo', 'repo.id', 'cr.repository_id')
    .where('rev.tenant_id', '=', tenantId)
    .where('cr.tenant_id', '=', tenantId)
    .where('repo.tenant_id', '=', tenantId);
  if (filters.repositoryId) base = base.where('cr.repository_id', '=', filters.repositoryId);
  if (filters.status === 'blocked') base = base.where('rev.gate_state', '=', 'block');
  if (filters.status === 'failed') base = base.where(latestStage, '=', 'failed');
  if (filters.status === 'running')
    base = base.where((eb) => eb.and([eb(latestStage, 'not in', ['done', 'failed', 'cancelled']), eb(latestFinished, 'is', null)]));

  const totalRow = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const sortCol = { createdAt: 'rev.created_at', change: 'cr.number', repository: 'repo.namespace' }[
    params.sort as 'createdAt' | 'change' | 'repository'
  ] ?? 'rev.created_at';
  const rows = await base
    .select([
      'rev.id as revisionId',
      'rev.head_sha as headSha',
      'rev.created_at as createdAt',
      'rev.source_branch as sourceBranch',
      'rev.target_branch as targetBranch',
      'rev.gate_state as gate',
      'rev.blocking_count as blockingCount',
      'cr.number as changeNumber',
      'cr.kind as changeKind',
      'cr.title as title',
      'repo.id as repositoryId',
      'repo.namespace as ns',
      'repo.name as name',
    ])
    .orderBy(sortCol as 'rev.created_at', params.dir)
    .orderBy('rev.id', 'desc')
    .limit(params.limit)
    .offset(params.offset)
    .execute();

  const facts = await runFacts(db, tenantId, rows.map((r) => r.revisionId));
  const items = rows.map((r): ReviewRunRow => {
    const p = facts.progress.get(r.revisionId);
    const c = facts.costs.get(r.revisionId);
    const o = facts.occ.get(r.revisionId);
    const state = stateOf(p?.stage, p?.finished_at);
    return {
      revisionId: r.revisionId,
      headSha: r.headSha,
      createdAt: iso(r.createdAt),
      repository: `${r.ns}/${r.name}`,
      repositoryId: r.repositoryId,
      changeNumber: r.changeNumber,
      changeKind: r.changeKind,
      title: r.title,
      sourceBranch: r.sourceBranch,
      targetBranch: r.targetBranch,
      state,
      progress: p && state === 'running' ? progressView(p) : null,
      candidates: c?.candidates ?? null,
      verified: o?.verified ?? 0,
      published: o?.published ?? 0,
      topSeverity: worstSeverity(o?.severities ?? []),
      gate: r.gate,
      blockingCount: r.blockingCount,
      costUsd: c?.costUsd ?? null,
    };
  });
  return paged(items, Number(totalRow?.n ?? 0), params);
}

export interface ReviewFinding {
  findingId: string;
  claim: string;
  category: string;
  severity: string;
  state: string;
  changeRelation: string;
  confirmation: string;
  blocking: boolean;
  effort: string | null;
  lifecycle: string;
  path: string | null;
  line: number | null;
}

export interface ReviewDetail {
  run: ReviewRunRow;
  baseSha: string;
  changeState: string;
  areas: { complete: number; total: number } | null;
  /** inline + summary: the conclusions posted to the PR. */
  findings: ReviewFinding[];
  /** Posted at the end of the summary as unproven risks. */
  risks: ReviewFinding[];
  suppressed: { findingId: string; claim: string; severity: string; reason: string | null }[];
  /** Candidates overturned in verification or refutation (never persisted). */
  refutedCount: number;
  publications: { kind: string; state: string; providerUrl: string | null }[];
}

function anchorOf(anchor: unknown): { path: string | null; line: number | null } {
  const a = (anchor ?? {}) as { path?: unknown; line?: unknown };
  return { path: typeof a.path === 'string' ? a.path : null, line: typeof a.line === 'number' ? a.line : null };
}

export async function getReviewDetail(db: Db, tenantId: string, revisionId: string): Promise<ReviewDetail | null> {
  const r = await db
    .selectFrom('revisions as rev')
    .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
    .innerJoin('repositories as repo', 'repo.id', 'cr.repository_id')
    .select([
      'rev.id as revisionId',
      'rev.head_sha as headSha',
      'rev.base_sha as baseSha',
      'rev.created_at as createdAt',
      'rev.source_branch as sourceBranch',
      'rev.target_branch as targetBranch',
      'rev.gate_state as gate',
      'rev.blocking_count as blockingCount',
      'cr.number as changeNumber',
      'cr.kind as changeKind',
      'cr.title as title',
      'cr.state as changeState',
      'repo.id as repositoryId',
      'repo.namespace as ns',
      'repo.name as name',
    ])
    .where('rev.tenant_id', '=', tenantId)
    .where('cr.tenant_id', '=', tenantId)
    .where('repo.tenant_id', '=', tenantId)
    .where('rev.id', '=', revisionId)
    .executeTakeFirst();
  if (!r) return null;

  const [facts, occ, pubs] = await Promise.all([
    runFacts(db, tenantId, [revisionId]),
    db
      .selectFrom('finding_occurrences as fo')
      .innerJoin('findings as f', 'f.id', 'fo.finding_id')
      .select([
        'fo.finding_id as findingId',
        'fo.claim as claim',
        'f.canonical_claim as canonicalClaim',
        'f.category as category',
        'f.lifecycle as lifecycle',
        'fo.severity as severity',
        'fo.state as state',
        'fo.change_relation as changeRelation',
        'fo.confirmation as confirmation',
        'fo.blocking as blocking',
        'fo.effort as effort',
        'fo.anchor as anchor',
        'fo.suppress_reason as suppressReason',
      ])
      .where('fo.tenant_id', '=', tenantId)
      .where('f.tenant_id', '=', tenantId)
      .where('fo.revision_id', '=', revisionId)
      .execute(),
    db
      .selectFrom('publication_records')
      .select(['kind', 'state', 'provider_url'])
      .where('tenant_id', '=', tenantId)
      .where('revision_id', '=', revisionId)
      .orderBy('created_at', 'asc')
      .execute(),
  ]);
  const p = facts.progress.get(revisionId);
  const c = facts.costs.get(revisionId);
  const o = facts.occ.get(revisionId);
  const state = stateOf(p?.stage, p?.finished_at);
  const toFinding = (x: (typeof occ)[number]): ReviewFinding => ({
    findingId: x.findingId,
    claim: x.claim ?? x.canonicalClaim,
    category: x.category,
    severity: x.severity,
    state: x.state,
    changeRelation: x.changeRelation,
    confirmation: x.confirmation,
    blocking: x.blocking,
    effort: x.effort,
    lifecycle: x.lifecycle,
    ...anchorOf(x.anchor),
  });
  const bySeverity = (a: ReviewFinding, b: ReviewFinding): number => severityRank(a.severity) - severityRank(b.severity);
  return {
    run: {
      revisionId: r.revisionId,
      headSha: r.headSha,
      createdAt: iso(r.createdAt),
      repository: `${r.ns}/${r.name}`,
      repositoryId: r.repositoryId,
      changeNumber: r.changeNumber,
      changeKind: r.changeKind,
      title: r.title,
      sourceBranch: r.sourceBranch,
      targetBranch: r.targetBranch,
      state,
      progress: p && state === 'running' ? progressView(p) : null,
      candidates: c?.candidates ?? null,
      verified: o?.verified ?? 0,
      published: o?.published ?? 0,
      topSeverity: worstSeverity(o?.severities ?? []),
      gate: r.gate,
      blockingCount: r.blockingCount,
      costUsd: c?.costUsd ?? null,
    },
    baseSha: r.baseSha,
    changeState: r.changeState,
    areas: c && c.scopesTotal > 0 ? { complete: c.scopesComplete, total: c.scopesTotal } : null,
    findings: occ.filter((x) => PUBLISHED_STATES.includes(x.state)).map(toFinding).sort(bySeverity),
    risks: occ.filter((x) => RISK_STATES.includes(x.state)).map(toFinding).sort(bySeverity),
    suppressed: occ
      .filter((x) => x.state === 'suppressed')
      .map((x) => ({ findingId: x.findingId, claim: x.claim ?? x.canonicalClaim, severity: x.severity, reason: x.suppressReason })),
    refutedCount: Math.max(0, (c?.candidates ?? 0) - (o?.verified ?? 0)),
    publications: pubs.map((x) => ({ kind: x.kind, state: x.state, providerUrl: x.provider_url })),
  };
}

export interface FindingRow {
  id: string;
  claim: string;
  category: string;
  lifecycle: string;
  severity: string;
  occurrenceCount: number;
  lastSeenAt: string;
  repository: string;
  repositoryId: string;
  /** Latest review that reported it. */
  changeNumber: number | null;
  revisionId: string | null;
}

export const FINDING_SORTS = ['lastSeenAt', 'severity', 'occurrences'] as const;
export interface FindingFilters {
  /** open | resolved | dismissed */
  status?: string | undefined;
  repositoryId?: string | undefined;
  severity?: string | undefined;
  q?: string | undefined;
}


const sevRankSql = sql<number>`min(case fo.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end)`;

export async function listFindings(
  db: Db,
  tenantId: string,
  params: ListParams,
  filters: FindingFilters = {},
): Promise<Paged<FindingRow>> {
  let base = db
    .selectFrom('findings as f')
    .innerJoin('repositories as repo', 'repo.id', 'f.repository_id')
    .where('f.tenant_id', '=', tenantId)
    .where('repo.tenant_id', '=', tenantId);
  // Dismissals are per change request and leave the lifecycle alone; any dismissal counts here.
  const dismissed = sql<boolean>`exists (select 1 from finding_dismissals fd where fd.finding_id = f.id and fd.tenant_id = ${tenantId})`;
  if (filters.status === 'open') base = base.where('f.lifecycle', 'in', ACTIVE_LIFECYCLES).where(sql<boolean>`not ${dismissed}`);
  if (filters.status === 'resolved') base = base.where('f.lifecycle', '=', 'resolved');
  if (filters.status === 'dismissed') base = base.where(dismissed);
  if (filters.repositoryId) base = base.where('f.repository_id', '=', filters.repositoryId);
  if (filters.q) base = base.where('f.canonical_claim', 'ilike', `%${filters.q}%`);
  if (filters.severity) {
    const sev = filters.severity;
    base = base.where((eb) =>
      eb.exists(
        eb
          .selectFrom('finding_occurrences as fx')
          .select('fx.id')
          .whereRef('fx.finding_id', '=', 'f.id')
          .where('fx.tenant_id', '=', tenantId)
          .where('fx.severity', '=', sev),
      ),
    );
  }
  const totalRow = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const sortCol = { lastSeenAt: 'f.last_seen_at', severity: 'sevRank', occurrences: 'occ' }[
    params.sort as 'lastSeenAt' | 'severity' | 'occurrences'
  ] ?? 'f.last_seen_at';
  const rows = await base
    .leftJoin('finding_occurrences as fo', (join) => join.onRef('fo.finding_id', '=', 'f.id').on('fo.tenant_id', '=', tenantId))
    .select((eb) => [
      'f.id as id',
      'f.canonical_claim as claim',
      'f.category as category',
      'f.lifecycle as lifecycle',
      'f.last_seen_at as lastSeenAt',
      'repo.id as repositoryId',
      'repo.namespace as ns',
      'repo.name as name',
      eb.fn.count('fo.id').as('occ'),
      sevRankSql.as('sevRank'),
    ])
    .groupBy(['f.id', 'f.canonical_claim', 'f.category', 'f.lifecycle', 'f.last_seen_at', 'repo.id', 'repo.namespace', 'repo.name'])
    .orderBy(sortCol as 'f.last_seen_at', params.dir)
    .orderBy('f.id', 'desc')
    .limit(params.limit)
    .offset(params.offset)
    .execute();

  const ids = rows.map((r) => r.id);
  const latest = ids.length
    ? await db
        .selectFrom('finding_occurrences as fo')
        .innerJoin('revisions as rev', 'rev.id', 'fo.revision_id')
        .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
        .select(['fo.finding_id', 'fo.revision_id', 'cr.number', 'fo.created_at'])
        .where('fo.tenant_id', '=', tenantId)
        .where('fo.finding_id', 'in', ids)
        .orderBy('fo.created_at', 'desc')
        .execute()
    : [];
  const latestOf = new Map<string, (typeof latest)[number]>();
  for (const l of latest) if (!latestOf.has(l.finding_id)) latestOf.set(l.finding_id, l);

  const items = rows.map((r): FindingRow => {
    const l = latestOf.get(r.id);
    return {
      id: r.id,
      claim: r.claim,
      category: r.category,
      lifecycle: r.lifecycle,
      severity: SEVERITIES[Number(r.sevRank ?? 4)] ?? 'info',
      occurrenceCount: Number(r.occ),
      lastSeenAt: iso(r.lastSeenAt),
      repository: `${r.ns}/${r.name}`,
      repositoryId: r.repositoryId,
      changeNumber: l?.number ?? null,
      revisionId: l?.revision_id ?? null,
    };
  });
  return paged(items, Number(totalRow?.n ?? 0), params);
}

export interface SuppressedRow {
  findingId: string;
  claim: string;
  category: string;
  severity: string;
  reason: string | null;
  repository: string;
  changeNumber: number;
  revisionId: string;
  createdAt: string;
}

export const SUPPRESSED_SORTS = ['createdAt'] as const;
export interface SuppressedFilters {
  repositoryId?: string | undefined;
  q?: string | undefined;
}

export async function listSuppressed(
  db: Db,
  tenantId: string,
  params: ListParams,
  filters: SuppressedFilters = {},
): Promise<Paged<SuppressedRow>> {
  let base = db
    .selectFrom('finding_occurrences as fo')
    .innerJoin('findings as f', 'f.id', 'fo.finding_id')
    .innerJoin('revisions as rev', 'rev.id', 'fo.revision_id')
    .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
    .innerJoin('repositories as repo', 'repo.id', 'cr.repository_id')
    .where('fo.tenant_id', '=', tenantId)
    .where('f.tenant_id', '=', tenantId)
    .where('fo.state', '=', 'suppressed');
  if (filters.repositoryId) base = base.where('cr.repository_id', '=', filters.repositoryId);
  if (filters.q) base = base.where('f.canonical_claim', 'ilike', `%${filters.q}%`);
  const totalRow = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const rows = await base
    .select([
      'fo.finding_id as findingId',
      'fo.claim as claim',
      'f.canonical_claim as canonicalClaim',
      'f.category as category',
      'fo.severity as severity',
      'fo.suppress_reason as reason',
      'fo.revision_id as revisionId',
      'fo.created_at as createdAt',
      'cr.number as changeNumber',
      'repo.namespace as ns',
      'repo.name as name',
    ])
    .orderBy('fo.created_at', params.dir)
    .orderBy('fo.id', 'desc')
    .limit(params.limit)
    .offset(params.offset)
    .execute();
  const items = rows.map((r) => ({
    findingId: r.findingId,
    claim: r.claim ?? r.canonicalClaim,
    category: r.category,
    severity: r.severity,
    reason: r.reason,
    repository: `${r.ns}/${r.name}`,
    changeNumber: r.changeNumber,
    revisionId: r.revisionId,
    createdAt: iso(r.createdAt),
  }));
  return paged(items, Number(totalRow?.n ?? 0), params);
}

export interface FindingDetailView {
  id: string;
  claim: string;
  category: string;
  lifecycle: string;
  repository: string;
  repositoryId: string;
  /** The occurrence shown: the requested revision's, or the latest. */
  occurrence: {
    revisionId: string;
    headSha: string;
    changeNumber: number;
    changeRequestId: string;
    severity: string;
    state: string;
    changeRelation: string;
    confirmation: string;
    blocking: boolean;
    effort: string | null;
    refuterUpheld: boolean | null;
    rationale: string | null;
    evidence: unknown[];
    suppressReason: string | null;
    path: string | null;
    line: number | null;
    codeContext: { startLine: number; lines: string[] } | null;
    suggestion: { startLine: number; endLine: number; replacement: string } | null;
  } | null;
  dismissal: { reason: string | null; actor: string | null; at: string } | null;
  history: { revisionId: string; headSha: string; changeNumber: number; state: string; severity: string; createdAt: string }[];
}

export async function getFindingDetail(
  db: Db,
  tenantId: string,
  findingId: string,
  revisionId?: string,
): Promise<FindingDetailView | null> {
  const f = await db
    .selectFrom('findings as f')
    .innerJoin('repositories as repo', 'repo.id', 'f.repository_id')
    .select(['f.id', 'f.canonical_claim', 'f.category', 'f.lifecycle', 'repo.id as repositoryId', 'repo.namespace', 'repo.name'])
    .where('f.tenant_id', '=', tenantId)
    .where('f.id', '=', findingId)
    .executeTakeFirst();
  if (!f) return null;
  const occ = await db
    .selectFrom('finding_occurrences as fo')
    .innerJoin('revisions as rev', 'rev.id', 'fo.revision_id')
    .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
    .select([
      'fo.revision_id',
      'fo.claim',
      'fo.severity',
      'fo.state',
      'fo.change_relation',
      'fo.confirmation',
      'fo.blocking',
      'fo.effort',
      'fo.refuter_upheld',
      'fo.rationale',
      'fo.evidence',
      'fo.suppress_reason',
      'fo.code_context',
      'fo.suggestion',
      'fo.anchor',
      'fo.created_at',
      'rev.head_sha',
      'cr.id as change_request_id',
      'cr.number',
    ])
    .where('fo.tenant_id', '=', tenantId)
    .where('fo.finding_id', '=', findingId)
    .orderBy('fo.created_at', 'desc')
    .execute();
  const shown = (revisionId ? occ.find((o) => o.revision_id === revisionId) : undefined) ?? occ[0];
  const dismissal = await db
    .selectFrom('finding_dismissals')
    .select(['reason', 'actor', 'created_at'])
    .where('tenant_id', '=', tenantId)
    .where('finding_id', '=', findingId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return {
    id: f.id,
    claim: shown?.claim ?? f.canonical_claim,
    category: f.category,
    lifecycle: f.lifecycle,
    repository: `${f.namespace}/${f.name}`,
    repositoryId: f.repositoryId,
    occurrence: shown
      ? {
          revisionId: shown.revision_id,
          headSha: shown.head_sha,
          changeNumber: shown.number,
          changeRequestId: shown.change_request_id,
          severity: shown.severity,
          state: shown.state,
          changeRelation: shown.change_relation,
          confirmation: shown.confirmation,
          blocking: shown.blocking,
          effort: shown.effort,
          refuterUpheld: shown.refuter_upheld,
          rationale: shown.rationale,
          evidence: (shown.evidence as unknown[]) ?? [],
          suppressReason: shown.suppress_reason,
          codeContext: shown.code_context,
          suggestion: shown.suggestion,
          ...anchorOf(shown.anchor),
        }
      : null,
    dismissal: dismissal ? { reason: dismissal.reason, actor: dismissal.actor, at: iso(dismissal.created_at) } : null,
    history: occ.map((o) => ({
      revisionId: o.revision_id,
      headSha: o.head_sha,
      changeNumber: o.number,
      state: o.state,
      severity: o.severity,
      createdAt: iso(o.created_at),
    })),
  };
}
