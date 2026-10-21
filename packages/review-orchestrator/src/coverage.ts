/** Cross-round coverage ledger: which files this round reviewed, what each depends on, what was planned but not run. */
import type { ReviewLedger } from '@reviewbot/review-engine';

/** The slice of `ProducedReview` coverage needs (avoids a cycle with orchestrator). */
interface CoverageSource {
  ledger: ReviewLedger;
  unverifiedCandidateIds?: string[];
}

export const normaliseReviewPath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Changed files covered by scopes that completed exploration. The ledger prefers under- to over-counting:
 * - only `complete` scopes count; scopes without `files` contribute nothing;
 * - a scope only accounts for its own declared `files`, narrowed by its `exploredEntities`, so incidental
 *   reads never claim another (possibly unrun) scope's files;
 * - if `exploredEntities` matches none of its `files`, fall back to `files` (the model did not report paths;
 *   treating it as zero coverage would disable auto-approve forever).
 */
export function coveredPathsOf(
  ledger: ReviewLedger,
  unverifiedCandidateIds: ReadonlySet<string> = new Set(),
): string[] {
  const filesByScopeId = new Map(
    ledger.scopes.map((scope) => [scope.id, (scope.files ?? []).map(normaliseReviewPath)]),
  );
  /*
   * Files with a candidate left unverified for capacity reasons (cost/wall-clock/cancel) are not covered.
   * Dedup-folded candidates do not count: a survivor represents them.
   */
  const unverifiedPaths = new Set(
    ledger.candidates
      .filter((candidate) => unverifiedCandidateIds.has(candidate.id))
      .map((candidate) => normaliseReviewPath(candidate.path)),
  );
  // A file shared by several scopes is covered only if all of them completed.
  const completeIds = new Set(ledger.scopeOutcomes.filter((o) => o.status === 'complete').map((o) => o.scopeId));
  const unfinished = new Set(
    ledger.scopes.filter((s) => !completeIds.has(s.id)).flatMap((s) => (s.files ?? []).map(normaliseReviewPath)),
  );
  const paths = new Set<string>();
  for (const o of ledger.scopeOutcomes) {
    if (o.status !== 'complete') continue;
    const declared = filesByScopeId.get(o.scopeId) ?? [];
    if (declared.length === 0) continue;
    const explored = new Set(o.exploredEntities.map(normaliseReviewPath));
    const narrowed = declared.filter((path) => explored.has(path));
    for (const path of narrowed.length > 0 ? narrowed : declared) {
      if (!unverifiedPaths.has(path) && !unfinished.has(path)) paths.add(path);
    }
  }
  return [...paths];
}

/**
 * Covered files plus their dependencies: files the covering scopes actually read that this PR did not change.
 * If a dependency changes later, the file must be re-reviewed. Files changed by the PR are excluded: they
 * re-enter review on their own, and including them would make every file in a multi-file scope depend on the rest.
 */
export function coveredFilesOf(
  produced: CoverageSource,
  deps: { reviewFileStates?: readonly { path: string; materialDigest: string }[] },
): { path: string; materialDigest: string; dependencies: string[]; note?: string }[] {
  const covered = new Set(coveredPathsOf(produced.ledger, unverifiedIdsOf(produced)));
  const readsByPath = new Map<string, Set<string>>();
  const noteByPath = new Map<string, string>();
  const filesByScopeId = new Map(
    produced.ledger.scopes.map((scope) => [scope.id, (scope.files ?? []).map(normaliseReviewPath)]),
  );
  for (const o of produced.ledger.scopeOutcomes) {
    for (const path of filesByScopeId.get(o.scopeId) ?? []) {
      const reads = readsByPath.get(path) ?? new Set<string>();
      for (const read of o.readPaths ?? []) reads.add(normaliseReviewPath(read));
      readsByPath.set(path, reads);
    }
    // Only keep notes for the scope's own files.
    const own = new Set(filesByScopeId.get(o.scopeId) ?? []);
    for (const n of o.fileNotes ?? []) {
      const path = normaliseReviewPath(n.path);
      if (own.has(path) && !noteByPath.has(path)) noteByPath.set(path, n.summary);
    }
  }
  const changed = new Set((deps.reviewFileStates ?? []).map((file) => normaliseReviewPath(file.path)));
  return (deps.reviewFileStates ?? [])
    .filter((file) => covered.has(normaliseReviewPath(file.path)))
    .map((file) => {
      const path = normaliseReviewPath(file.path);
      const dependencies = [...(readsByPath.get(path) ?? [])].filter((dep) => !changed.has(dep)).sort();
      const note = noteByPath.get(path);
      return { ...file, dependencies, ...(note !== undefined ? { note } : {}) };
    });
}

/**
 * User-facing "reviewed x/y sections" as planned by map. Split parts form one section, complete only when all
 * parts complete. Remainder scopes are not sections (their unfinished files still block approve).
 */
export function sectionCoverage(ledger: ReviewLedger): { completed: number; total: number } {
  const complete = new Set(ledger.scopeOutcomes.filter((o) => o.status === 'complete').map((o) => o.scopeId));
  const sections = new Map<string, boolean>();
  for (const s of ledger.scopes) {
    if (s.origin === 'remainder') continue;
    const id = s.part?.sectionId ?? s.id;
    sections.set(id, (sections.get(id) ?? true) && complete.has(s.id));
  }
  return { completed: [...sections.values()].filter(Boolean).length, total: sections.size };
}

/** Candidates left unverified by capacity gates (cost/wall-clock/cancel); dedup-folded ones excluded. */
export function unverifiedIdsOf(produced: CoverageSource): ReadonlySet<string> {
  return new Set(produced.unverifiedCandidateIds ?? []);
}

/**
 * Changed files map planned into scopes, whether or not dig ran. Planned-but-unrun and unclaimed files both
 * block approve. `ReviewScope.files` is optional in the schema, so an empty result means the caller must fall
 * back to single-round accounting instead of treating it as "nothing covered".
 */
export function plannedPathsOf(ledger: ReviewLedger): string[] {
  const paths = new Set<string>();
  for (const s of ledger.scopes) for (const f of s.files ?? []) paths.add(normaliseReviewPath(f));
  return [...paths];
}
