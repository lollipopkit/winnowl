import type { DiffFile, DiffLineKind } from './types.js';

const MARKER: Record<DiffLineKind, string> = { context: ' ', added: '+', deleted: '-' };

/** One file of a canonical diff back as unified-diff text (`---`/`+++` headers, then its hunks). */
export function renderFilePatch(file: DiffFile): string {
  const out = [
    `--- ${file.oldPath !== undefined ? `a/${file.oldPath}` : '/dev/null'}`,
    `+++ ${file.newPath !== undefined && file.status !== 'deleted' ? `b/${file.newPath}` : '/dev/null'}`,
  ];
  if (file.isBinary) out.push('(binary file)');
  for (const h of file.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.heading ? ` ${h.heading}` : ''}`);
    for (const l of h.lines) out.push(`${MARKER[l.kind]}${l.raw}`);
  }
  return out.join('\n');
}
