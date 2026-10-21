import { matchesGlob } from '@reviewbot/knowledge';
import type { SourceProvider } from '@reviewbot/agent-pi';
import type { ChangedFileEntry } from '@reviewbot/code-intel';
import type { SubmoduleCheckout } from '@reviewbot/git-repository';
import type { SubmoduleBump } from '@reviewbot/review-orchestrator';
import type { SkipReason } from './generated-files.js';

/** A changed file left out of review: by the first matching glob, or as generated/vendored/binary. */
export type IgnoredFile = { path: string; glob: string } | { path: string; reason: SkipReason };

/** Submodule bumps skipped as `submodule`; ones ignored by glob are omitted too. */
export function submoduleBumpsOf(
  ignored: readonly IgnoredFile[],
  checkouts: readonly SubmoduleCheckout[] | undefined,
): SubmoduleBump[] | undefined {
  const byPath = new Map((checkouts ?? []).map((c) => [c.path, c]));
  const bumps = ignored.flatMap((f): SubmoduleBump[] => {
    if (!('reason' in f) || f.reason !== 'submodule') return [];
    const c = byPath.get(f.path);
    if (!c) return [];
    return [
      {
        path: c.path,
        toSha: c.sha,
        checkedOut: c.status === 'checked-out',
        ...(c.previousSha !== undefined ? { fromSha: c.previousSha } : {}),
        ...(c.changes !== undefined ? { changes: c.changes } : {}),
      },
    ];
  });
  return bumps.length > 0 ? bumps : undefined;
}

export interface PartitionResult {
  kept: ChangedFileEntry[];
  ignored: IgnoredFile[];
}

export function partitionIgnoredPaths(files: readonly ChangedFileEntry[], globs: readonly string[]): PartitionResult {
  const kept: ChangedFileEntry[] = [];
  const ignored: IgnoredFile[] = [];
  for (const f of files) {
    const hit = globs.find((g) => matchesGlob(g, f.path));
    if (hit !== undefined) ignored.push({ path: f.path, glob: hit });
    else kept.push(f);
  }
  return { kept, ignored };
}

interface FilterableWsView {
  source: SourceProvider;
  isChangedLine: (path: string, line: number) => boolean;
}

/**
 * Hides ignored files from `listChangedFiles` and `isChangedLine` for every downstream consumer.
 * Their contents stay readable: ignored means not reviewed, not invisible.
 */
export async function applyPathFilter<V extends FilterableWsView>(
  wsView: V,
  globs: readonly string[],
  /** Runs after globs; deleted files are not classified (no content). */
  classify?: (paths: string[]) => Promise<ReadonlyMap<string, SkipReason>>,
): Promise<{ wsView: V; changedFiles: ChangedFileEntry[]; ignoredFiles: IgnoredFile[] }> {
  const partition = partitionIgnoredPaths(await wsView.source.listChangedFiles(), globs);
  const ignored: IgnoredFile[] = partition.ignored;
  let kept = partition.kept;
  if (classify) {
    const reasons = await classify(kept.filter((f) => f.status !== 'deleted').map((f) => f.path));
    ignored.push(...kept.flatMap((f) => (reasons.has(f.path) ? [{ path: f.path, reason: reasons.get(f.path)! }] : [])));
    kept = kept.filter((f) => !reasons.has(f.path));
  }
  if (ignored.length === 0) return { wsView, changedFiles: kept, ignoredFiles: [] };
  const ignoredPaths = new Set(ignored.map((i) => i.path));
  const source: SourceProvider = {
    listChangedFiles: async () => kept,
    readFile: (path) => wsView.source.readFile(path),
    searchCode: (query) => wsView.source.searchCode(query),
    ...(wsView.source.searchSymbol ? { searchSymbol: (symbol: string) => wsView.source.searchSymbol!(symbol) } : {}),
  };
  const filtered = {
    ...wsView,
    source,
    isChangedLine: (path: string, line: number) => (ignoredPaths.has(path) ? false : wsView.isChangedLine(path, line)),
  };
  return { wsView: filtered, changedFiles: kept, ignoredFiles: ignored };
}
