import type { ReviewScope } from './types.js';

export const REMAINDER_SCOPE_MAX_FILES = 8;

/**
 * Changed files no map scope claimed; they become remainder scopes so every non-generated file gets reviewed.
 * Returns nothing when scopes exist but none lists `files` (coverage is unknowable); returns everything when
 * there are no scopes at all. Deleted files are skipped.
 */
export function unassignedFiles(
  scopes: readonly ReviewScope[],
  changed: readonly { path: string; status: string }[],
): string[] {
  if (scopes.length > 0 && !scopes.some((s) => (s.files?.length ?? 0) > 0)) return [];
  const claimed = new Set(scopes.flatMap((s) => (s.files ?? []).map(normalise)));
  return changed
    .filter((f) => f.status !== 'deleted' && !claimed.has(normalise(f.path)))
    .map((f) => f.path)
    .sort();
}

/** Chunks paths in directory order, at most `REMAINDER_SCOPE_MAX_FILES` per scope; small adjacent dirs share a scope. */
export function remainderScopes(paths: readonly string[], newId: () => string): ReviewScope[] {
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
  }
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const files of byDir.values()) {
    for (const path of files) {
      if (current.length >= REMAINDER_SCOPE_MAX_FILES) {
        chunks.push(current);
        current = [];
      }
      current.push(path);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((files) => {
    const dir = commonDir(files);
    return {
      id: newId(),
      title: dir ? `Other changes in ${dir}` : 'Other changes',
      origin: 'remainder' as const,
      changeSummary: `Changes to ${files.length} file(s)${dir ? ` under ${dir}` : ''} not covered by the other sections.`,
      obligations: [
        {
          id: newId(),
          kind: 'correctness',
          description:
            'Review each listed file like any other change: read its diff, follow what it touches, and report defects.',
        },
      ],
      files,
    };
  });
}

function commonDir(paths: readonly string[]): string {
  const split = paths.map((p) => p.split('/').slice(0, -1));
  const first = split[0] ?? [];
  let n = 0;
  while (n < first.length && split.every((s) => s[n] === first[n])) n += 1;
  return first.slice(0, n).join('/');
}

const normalise = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');
