import type { Db } from '@reviewbot/db';
import type { ChangeRelation } from '@reviewbot/domain';
import {
  blocksMerge,
  type BlockScope,
  type ConfirmationLevel,
  type FindingCategory,
  type Severity,
} from '@reviewbot/findings';
import { uuidv7 } from '@reviewbot/ids';
import { weakFingerprint } from './fingerprint.js';
import type { FindingLifecycle } from './reconcile.js';

export interface UpsertFindingInput {
  tenantId: string;
  repositoryId: string;
  fingerprint: string;
  category: string;
  canonicalClaim: string;
  now?: number;
  /**
   * Lifecycle for a newly inserted row (default `new`). Suppressed diagnostics pass `retracted`:
   * persisted for the console's suppressed view, but kept out of the active set so a later true
   * report is not mistaken for a recurrence.
   */
  lifecycle?: FindingLifecycle;
  /**
   * Existing finding chosen by cross-round identity matching; reused instead of inserting by fingerprint.
   * The fingerprint includes the LLM-rewritten claim, so the unique key alone would leave stale active rows.
   */
  matchedFindingId?: string;
}

/** Upsert a finding, deduplicated by repository + semantic_fingerprint. */
export async function upsertFinding(
  db: Db,
  input: UpsertFindingInput,
): Promise<{ id: string; isNew: boolean }> {
  const now = new Date(input.now ?? Date.now());

  if (input.matchedFindingId) {
    // Scope by repository_id so a foreign id cannot touch another repo. Not found falls back to insert
    // rather than throwing: a wrong identity match must not fail the review publish.
    const matched = await db
      .selectFrom('findings')
      .select(['id', 'lifecycle'])
      .where('id', '=', input.matchedFindingId)
      .where('repository_id', '=', input.repositoryId)
      .executeTakeFirst();
    if (matched) {
      await db.updateTable('findings').set({ last_seen_at: now, ...revive(matched.lifecycle) }).where('id', '=', matched.id).execute();
      return { id: matched.id, isNew: false };
    }
  }

  const inserted = await db
    .insertInto('findings')
    .values({
      id: uuidv7(input.now),
      tenant_id: input.tenantId,
      repository_id: input.repositoryId,
      semantic_fingerprint: input.fingerprint,
      category: input.category,
      canonical_claim: input.canonicalClaim,
      // Only applies on insert; a single round's suppression must not change an existing finding's lifecycle.
      lifecycle: input.lifecycle ?? 'new',
      first_seen_at: now,
      last_seen_at: now,
    })
    .onConflict((oc) => oc.columns(['repository_id', 'semantic_fingerprint']).doNothing())
    .returning('id')
    .executeTakeFirst();

  if (inserted) return { id: inserted.id, isNew: true };

  const existing = await db
    .selectFrom('findings')
    .select(['id', 'lifecycle'])
    .where('repository_id', '=', input.repositoryId)
    .where('semantic_fingerprint', '=', input.fingerprint)
    .executeTakeFirstOrThrow();
  await db.updateTable('findings').set({ last_seen_at: now, ...revive(existing.lifecycle) }).where('id', '=', existing.id).execute();
  return { id: existing.id, isNew: false };
}

/**
 * Only `stale` is revived on re-detection: it was inferred from absence, which a new report disproves.
 * `resolved` / `retracted` / `dismissed` are evidence-based decisions and stay.
 */
function revive(lifecycle: string): { lifecycle: FindingLifecycle } | Record<string, never> {
  return lifecycle === 'stale' ? { lifecycle: 'persisted' } : {};
}

export interface RecordOccurrenceInput {
  /** Carried on the occurrence so RLS can constrain it directly. */
  tenantId: string;
  findingId: string;
  reviewRunId?: string;
  revisionId: string;
  state: string;
  severity: string;
  changeRelation: string;
  confirmation: string;
  anchor?: { line?: number; path?: string };
  /** Flagged code window (= primaryAnchorText); focus for later targeted re-verification. */
  anchorText?: string;
  blocking?: boolean;
  /** Omitted = never demoted. */
  demotions?: string[];
  effort?: string;
  /** Omitted = refuter did not run. */
  refuterUpheld?: boolean;
  /** This round's claim; wording drifts after partial fixes, so display and matching use the latest. */
  claim?: string;
  rationale?: string;
  /** Set when state is `suppressed`. */
  suppressReason?: string;
  codeContext?: { startLine: number; lines: string[] };
  suggestion?: { startLine: number; endLine: number; replacement: string };
  evidence?: unknown[];
  now?: number;
}

export async function recordOccurrence(db: Db, input: RecordOccurrenceInput): Promise<void> {
  await db
    .insertInto('finding_occurrences')
    .values({
      id: uuidv7(input.now),
      tenant_id: input.tenantId,
      finding_id: input.findingId,
      review_run_id: input.reviewRunId ?? null,
      revision_id: input.revisionId,
      state: input.state,
      severity: input.severity,
      change_relation: input.changeRelation,
      confirmation: input.confirmation,
      anchor: input.anchor ?? null,
      anchor_text: input.anchorText ?? null,
      blocking: input.blocking ?? false,
      // jsonb arrays must be stringified: node-pg turns JS arrays into PG array literals, which jsonb rejects.
      demotions: JSON.stringify(input.demotions ?? []),
      evidence: JSON.stringify(input.evidence ?? []),
      effort: input.effort ?? null,
      refuter_upheld: input.refuterUpheld ?? null,
      claim: input.claim ?? null,
      rationale: input.rationale ?? null,
      suppress_reason: input.suppressReason ?? null,
      code_context: input.codeContext ? JSON.stringify(input.codeContext) : null,
      suggestion: input.suggestion ? JSON.stringify(input.suggestion) : null,
      created_at: new Date(input.now ?? Date.now()),
    })
    .onConflict((oc) => oc.columns(['finding_id', 'revision_id']).doNothing())
    .execute();
}

export interface ActiveFinding {
  id: string;
  fingerprint: string;
  lifecycle: string;
  lastLine?: number;
  /** Semantic fields for cross-round identity matching. */
  category: string;
  claim: string;
  path?: string;
  anchorText?: string;
  /**
   * Rounds (that produced findings) on this CR since this finding was last reported; 0 = this round.
   * Used by stale archiving.
   */
  roundsSinceLastSeen: number;
  /** Head sha of the round that last reported it; stale archiving checks whether the file changed since. */
  lastSeenHeadSha?: string;
  /**
   * The finding also has occurrences on other CRs. Lifecycle is repo-wide but stale evidence is per-CR,
   * so such findings are never archived (it would silence them on the other CR too).
   */
  seenOnOtherChangeRequests: boolean;
  /** Latest occurrence's severity and disposition, shown when the file was not re-reviewed this round. */
  severity?: string;
  state?: string;
  effort?: string;
}

export const ACTIVE_LIFECYCLES = ['new', 'published', 'persisted', 'moved', 'modified'];

interface LatestOccurrence {
  /** inline / summary (confirmed), low-evidence / unverified-risks (unconfirmed), suppressed. */
  state: string;
  effort: string | null;
  refuterUpheld: boolean | null;
  claim: string | null;
  blocking: boolean;
  severity: string;
  changeRelation: string;
  confirmation: string;
  anchor: { path?: string; line?: number } | null;
  anchorText: string | null;
  revisionId: string;
  headSha: string;
  createdAt: Date;
}

/**
 * Latest occurrence per finding within this CR. Finding identity is repo-wide, but "previous round"
 * only holds within one PR; scoping by repo would let another PR's blocking findings gate this one.
 * Rows come back newest first, so the first seen is the latest.
 */
async function latestOccurrencesInChangeRequest(
  db: Db,
  changeRequestId: string,
): Promise<{ latest: Map<string, LatestOccurrence>; roundIndex: ReadonlyMap<string, number> }> {
  const rows = await db
    .selectFrom('finding_occurrences as occ')
    .innerJoin('revisions as rev', 'rev.id', 'occ.revision_id')
    .select(['occ.finding_id', 'occ.state', 'occ.effort', 'occ.refuter_upheld', 'occ.claim', 'occ.blocking', 'occ.severity', 'occ.change_relation', 'occ.confirmation', 'occ.anchor', 'occ.anchor_text', 'occ.revision_id', 'rev.head_sha', 'occ.created_at'])
    .where('rev.change_request_id', '=', changeRequestId)
    .orderBy('occ.created_at', 'desc')
    .execute();

  const latest = new Map<string, LatestOccurrence>();
  // Distinct revisions on this CR that produced findings, newest first. Unreviewed revisions don't
  // count as rounds for stale archiving.
  const rounds: string[] = [];
  const seenRounds = new Set<string>();
  for (const row of rows) {
    if (!seenRounds.has(row.revision_id)) {
      seenRounds.add(row.revision_id);
      rounds.push(row.revision_id);
    }
    if (latest.has(row.finding_id)) continue;
    latest.set(row.finding_id, {
      state: row.state,
      effort: row.effort,
      refuterUpheld: row.refuter_upheld,
      claim: row.claim,
      blocking: row.blocking,
      severity: row.severity,
      changeRelation: row.change_relation,
      confirmation: row.confirmation,
      anchor: (row.anchor as { path?: string; line?: number } | null) ?? null,
      anchorText: row.anchor_text,
      revisionId: row.revision_id,
      headSha: row.head_sha,
      createdAt: row.created_at,
    });
  }
  const roundIndex = new Map(rounds.map((id, i) => [id, i]));
  return { latest, roundIndex };
}

/**
 * Active findings already reported on this CR, with their latest anchor in this CR.
 * Ordered most recently reported first: identity matching relies on this order, and `where id in`
 * does not guarantee one.
 */
export async function loadActiveFindings(db: Db, repositoryId: string, changeRequestId: string): Promise<ActiveFinding[]> {
  const { latest, roundIndex } = await latestOccurrencesInChangeRequest(db, changeRequestId);
  if (latest.size === 0) return [];
  const rows = await db
    .selectFrom('findings')
    .select(['id', 'semantic_fingerprint', 'lifecycle', 'category', 'canonical_claim'])
    .where('repository_id', '=', repositoryId)
    .where('lifecycle', 'in', ACTIVE_LIFECYCLES)
    .where('id', 'in', [...latest.keys()])
    .execute();

  // Which of these findings also have occurrences on other CRs (stale-archiving guard).
  const elsewhere = new Set(
    (
      await db
        .selectFrom('finding_occurrences as occ')
        .innerJoin('revisions as rev', 'rev.id', 'occ.revision_id')
        .select('occ.finding_id')
        .where('occ.finding_id', 'in', [...latest.keys()])
        .where('rev.change_request_id', '!=', changeRequestId)
        .groupBy('occ.finding_id')
        .execute()
    ).map((r) => r.finding_id),
  );

  // `latest` was filled newest first, so key order is recency order.
  const recency = new Map([...latest.keys()].map((id, i) => [id, i]));
  const ordered = [...rows].sort((a, b) => (recency.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (recency.get(b.id) ?? Number.MAX_SAFE_INTEGER));

  return ordered.map((row) => {
    const occ = latest.get(row.id);
    const line = occ?.anchor?.line;
    const path = occ?.anchor?.path;
    return {
      id: row.id,
      fingerprint: row.semantic_fingerprint,
      lifecycle: row.lifecycle,
      category: row.category,
      claim: occ?.claim ?? row.canonical_claim,
      roundsSinceLastSeen: occ ? (roundIndex.get(occ.revisionId) ?? 0) : 0,
      seenOnOtherChangeRequests: elsewhere.has(row.id),
      ...(line !== undefined ? { lastLine: line } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(occ?.anchorText ? { anchorText: occ.anchorText } : {}),
      ...(occ?.headSha ? { lastSeenHeadSha: occ.headSha } : {}),
      ...(occ ? { severity: occ.severity, state: occ.state } : {}),
      ...(occ?.effort ? { effort: occ.effort } : {}),
    };
  });
}

/** Active blocking finding plus the latest occurrence fields needed to relocate it. */
export interface ActiveBlockingFinding {
  id: string;
  fingerprint: string;
  claim: string;
  category: string;
  severity: string;
  confirmation: string;
  /** Latest occurrence's flagged code window; undefined for old rows. */
  anchorText?: string;
  path?: string;
  line?: number;
}

export interface FindingFixContext {
  id: string;
  category: string;
  claim: string;
  path?: string;
  line?: number;
}

/** Load finding details (claim, category, latest anchor) for the fix agent. */
export async function loadFindingsForFix(db: Db, findingIds: string[]): Promise<FindingFixContext[]> {
  if (findingIds.length === 0) return [];
  const rows = await db
    .selectFrom('findings')
    .select(['id', 'category', 'canonical_claim'])
    .where('id', 'in', findingIds)
    .execute();
  const result: FindingFixContext[] = [];
  for (const row of rows) {
    const occ = await db
      .selectFrom('finding_occurrences')
      .select('anchor')
      .where('finding_id', '=', row.id)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    const anchor = (occ?.anchor as { path?: string; line?: number } | null) ?? null;
    result.push({
      id: row.id,
      category: row.category,
      claim: row.canonical_claim,
      ...(anchor?.path ? { path: anchor.path } : {}),
      ...(anchor?.line !== undefined ? { line: anchor.line } : {}),
    });
  }
  return result;
}

export async function setFindingLifecycle(
  db: Db,
  findingId: string,
  lifecycle: FindingLifecycle,
  now: number = Date.now(),
): Promise<void> {
  await db
    .updateTable('findings')
    .set({ lifecycle, last_seen_at: new Date(now) })
    .where('id', '=', findingId)
    .execute();
}

/**
 * Flip `blocking` on one occurrence (reverify downgrade). recordOccurrence no-ops on conflict,
 * so the existing row must be updated.
 */
export async function setOccurrenceBlocking(db: Db, findingId: string, revisionId: string, blocking: boolean): Promise<void> {
  await db
    .updateTable('finding_occurrences')
    .set({ blocking })
    .where('finding_id', '=', findingId)
    .where('revision_id', '=', revisionId)
    .execute();
}

/**
 * Dismiss a finding for one CR (`@bot ignore`). Does not touch `findings.lifecycle`, which is
 * repo-wide and would silence other PRs. Idempotent; undo with `undismissFinding`.
 */
export async function dismissFindingForChangeRequest(
  db: Db,
  input: { tenantId: string; findingId: string; changeRequestId: string; actor?: string; reason?: string; now?: number },
): Promise<void> {
  // Store the weak fingerprint now: the claim wording changes next round. Uses the latest occurrence's
  // anchor_text, the same input as the strong fingerprint at publish time.
  const f = await db
    .selectFrom('findings')
    .select(['repository_id', 'category'])
    .where('id', '=', input.findingId)
    .executeTakeFirst();
  const occ = await db
    .selectFrom('finding_occurrences')
    .select(['anchor_text', 'anchor'])
    .where('finding_id', '=', input.findingId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  const weak =
    f && occ?.anchor_text
      ? weakFingerprint({
          repositoryId: f.repository_id,
          category: f.category,
          codeWindow: occ.anchor_text,
          ...((occ.anchor as { path?: string } | null)?.path ? { path: (occ.anchor as { path: string }).path } : {}),
        })
      : null;
  await db
    .insertInto('finding_dismissals')
    .values({
      id: uuidv7(input.now),
      tenant_id: input.tenantId,
      finding_id: input.findingId,
      change_request_id: input.changeRequestId,
      actor: input.actor ?? null,
      reason: input.reason ?? null,
      weak_fingerprint: weak,
      created_at: new Date(input.now ?? Date.now()),
    })
    .onConflict((oc) => oc.columns(['finding_id', 'change_request_id']).doNothing())
    .execute();
}

/** Undo a dismissal (`@bot unignore`); returns whether one was actually removed. */
export async function undismissFinding(db: Db, findingId: string, changeRequestId: string): Promise<boolean> {
  const res = await db
    .deleteFrom('finding_dismissals')
    .where('finding_id', '=', findingId)
    .where('change_request_id', '=', changeRequestId)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

export async function loadDismissedFindingIds(db: Db, changeRequestId: string): Promise<Set<string>> {
  const rows = await db
    .selectFrom('finding_dismissals')
    .select('finding_id')
    .where('change_request_id', '=', changeRequestId)
    .execute();
  return new Set(rows.map((r) => r.finding_id));
}

export interface DismissedFinding {
  /** Strong fingerprint (includes the claim; drifts across rounds, fast path only). */
  fingerprint: string;
  /** Weak fingerprint (excludes the claim but includes the LLM-chosen anchor text; also drifts). */
  weakFingerprint?: string;
  category: string;
  claim: string;
  path?: string;
}

/**
 * Dismissed findings on this CR, for pre-publish filtering (candidates are not persisted yet).
 * Both fingerprints drift across rounds, so path + category + claim are returned for similarity matching.
 */
export async function loadDismissedFindings(db: Db, changeRequestId: string): Promise<DismissedFinding[]> {
  const rows = await db
    .selectFrom('finding_dismissals as fd')
    .innerJoin('findings as f', 'f.id', 'fd.finding_id')
    .select(['f.id as id', 'f.semantic_fingerprint as fingerprint', 'f.category as category', 'f.canonical_claim as claim', 'fd.weak_fingerprint as weak'])
    .where('fd.change_request_id', '=', changeRequestId)
    .execute();
  const out: DismissedFinding[] = [];
  for (const r of rows) {
    const occ = await db
      .selectFrom('finding_occurrences')
      .select('anchor')
      .where('finding_id', '=', r.id)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    const anchor = (occ?.anchor as { path?: string } | null) ?? null;
    out.push({
      fingerprint: r.fingerprint,
      ...(r.weak ? { weakFingerprint: r.weak } : {}),
      category: r.category,
      claim: r.claim,
      ...(anchor?.path ? { path: anchor.path } : {}),
    });
  }
  return out;
}

export interface ChangeRequestBlockingFinding extends ActiveBlockingFinding {
  /** Revision of the latest occurrence, so a downgrade flips exactly that occurrence. */
  revisionId: string;
}

/**
 * One active finding on this CR, blocking or not, for `@bot challenge` (which may target a
 * non-blocking comment). Dismissed, retracted and resolved findings are excluded.
 */
export async function loadChangeRequestActiveFinding(
  db: Db,
  changeRequestId: string,
  findingId: string,
): Promise<ChangeRequestBlockingFinding | undefined> {
  const { latest } = await latestOccurrencesInChangeRequest(db, changeRequestId);
  const occ = latest.get(findingId);
  if (!occ) return undefined;
  const row = await db
    .selectFrom('findings as f')
    .select(['f.id as id', 'f.semantic_fingerprint as fingerprint', 'f.canonical_claim as claim', 'f.category as category'])
    .where('f.id', '=', findingId)
    .where('f.lifecycle', 'in', ACTIVE_LIFECYCLES)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('finding_dismissals as fd')
            .select('fd.id')
            .whereRef('fd.finding_id', '=', 'f.id')
            .where('fd.change_request_id', '=', changeRequestId),
        ),
      ),
    )
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    claim: occ.claim ?? row.claim,
    category: row.category,
    severity: occ.severity,
    confirmation: occ.confirmation,
    revisionId: occ.revisionId,
    ...(occ.anchorText != null ? { anchorText: occ.anchorText } : {}),
    ...(occ.anchor?.path ? { path: occ.anchor.path } : {}),
    ...(occ.anchor?.line !== undefined ? { line: occ.anchor.line } : {}),
  };
}

/**
 * Findings still blocking on this CR (one PR, not the whole repo), shared by the auto-approve gate
 * and reverify. "Still blocking" is judged on the latest occurrence only, so a reverify downgrade is
 * not overridden by an older blocking occurrence.
 */
export async function loadChangeRequestBlockingFindings(
  db: Db,
  changeRequestId: string,
  blockScope: BlockScope = {},
): Promise<ChangeRequestBlockingFinding[]> {
  const { latest } = await latestOccurrencesInChangeRequest(db, changeRequestId);
  // Must be blocking when written (reverify downgrades flip that) and still block under the current
  // gate (`blocksMerge`), so config changes apply to historical items without waiting for a new review.
  const concludedIds = [...latest].filter(([, occ]) => occ.blocking).map(([id]) => id);
  if (concludedIds.length === 0) return [];
  const candidates = await db
    .selectFrom('findings as f')
    .select(['f.id as id', 'f.semantic_fingerprint as fingerprint', 'f.canonical_claim as claim', 'f.category as category'])
    .where('f.id', 'in', concludedIds)
    .where('f.lifecycle', 'in', ACTIVE_LIFECYCLES)
    // Dismissed on this CR via `@bot ignore`.
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('finding_dismissals as fd')
            .select('fd.id')
            .whereRef('fd.finding_id', '=', 'f.id')
            .where('fd.change_request_id', '=', changeRequestId),
        ),
      ),
    )
    .execute();

  const rows = candidates.filter((row) => {
    const occ = latest.get(row.id)!;
    return blocksMerge(
      {
        severity: occ.severity as Severity,
        category: row.category as FindingCategory,
        changeRelation: occ.changeRelation as ChangeRelation,
        confirmation: occ.confirmation as ConfirmationLevel,
        // No refuter result means no refuter endorsement.
        refuterUpheld: occ.refuterUpheld ?? false,
      },
      blockScope,
    );
  });

  return rows
    .map((row) => {
      const occ = latest.get(row.id)!;
      return {
        id: row.id,
        fingerprint: row.fingerprint,
        claim: occ.claim ?? row.claim,
        category: row.category,
        severity: occ.severity,
        confirmation: occ.confirmation,
        revisionId: occ.revisionId,
        createdAt: occ.createdAt,
        ...(occ.anchorText != null ? { anchorText: occ.anchorText } : {}),
        ...(occ.anchor?.path ? { path: occ.anchor.path } : {}),
        ...(occ.anchor?.line !== undefined ? { line: occ.anchor.line } : {}),
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) // newest first, so capped reverify covers the latest
    .map(({ createdAt: _createdAt, ...f }) => f);
}
