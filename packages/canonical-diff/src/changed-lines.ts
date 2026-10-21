import type { CanonicalDiff } from './types.js';

export interface ChangedLines {
  added: Set<number>;
  deleted: Set<number>;
}

export function changedLinesByPath(diff: CanonicalDiff): Map<string, ChangedLines> {
  const map = new Map<string, ChangedLines>();
  for (const file of diff.files) {
    const key = file.newPath ?? file.oldPath;
    if (!key) continue;
    const entry: ChangedLines = { added: new Set(), deleted: new Set() };
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'added' && line.newLine !== undefined) entry.added.add(line.newLine);
        if (line.kind === 'deleted' && line.oldLine !== undefined) entry.deleted.add(line.oldLine);
      }
    }
    map.set(key, entry);
  }
  return map;
}

export function isChangedLine(
  changed: Map<string, ChangedLines>,
  path: string,
  side: 'base' | 'head',
  line: number,
): boolean {
  const entry = changed.get(path);
  if (!entry) return false;
  return side === 'head' ? entry.added.has(line) : entry.deleted.has(line);
}
