import type { SourceProvider } from '@reviewbot/agent-pi';
import type { ReviewScope, ScopeFocus } from './types.js';

/**
 * Large scopes are split into several digs, each responsible for at most `FOCUS_MAX_LINES` changed head-side
 * lines; a single dig over a big change stops early and misses defects. 250 measured best on `pnpm eval:recall`
 * (150 found no more and was slower).
 */
export const FOCUS_MAX_LINES = 250;
/** Changed ranges separated by at most this many unchanged lines are merged. */
const MERGE_GAP = 8;

interface Range {
  path: string;
  startLine: number;
  endLine: number;
}

export function changedRanges(path: string, lineCount: number, isChangedLine: (path: string, line: number) => boolean): Range[] {
  const ranges: Range[] = [];
  for (let line = 1; line <= lineCount; line += 1) {
    if (!isChangedLine(path, line)) continue;
    const last = ranges[ranges.length - 1];
    if (last && line - last.endLine <= MERGE_GAP + 1) last.endLine = line;
    else ranges.push({ path, startLine: line, endLine: line });
  }
  return ranges;
}

const size = (r: Range): number => r.endLine - r.startLine + 1;

/** Cuts oversized ranges into `max`-line windows, then packs them in order into parts of at most `max` lines. */
export function packFocus(ranges: readonly Range[], max = FOCUS_MAX_LINES): ScopeFocus[][] {
  const pieces: Range[] = [];
  for (const r of ranges) {
    for (let start = r.startLine; start <= r.endLine; start += max) {
      pieces.push({ path: r.path, startLine: start, endLine: Math.min(r.endLine, start + max - 1) });
    }
  }
  const parts: ScopeFocus[][] = [];
  let current: ScopeFocus[] = [];
  let lines = 0;
  for (const p of pieces) {
    if (current.length > 0 && lines + size(p) > max) {
      parts.push(current);
      current = [];
      lines = 0;
    }
    current.push(p);
    lines += size(p);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** No split without `isChangedLine` or when a scope lists no `files`. */
export async function splitByFocus(
  scopes: readonly ReviewScope[],
  deps: { source: SourceProvider; isChangedLine?: (path: string, line: number) => boolean; newId: () => string },
): Promise<ReviewScope[]> {
  const isChangedLine = deps.isChangedLine;
  if (!isChangedLine) return [...scopes];
  const lineCounts = new Map<string, number>();
  const lineCount = async (path: string): Promise<number> => {
    if (!lineCounts.has(path)) lineCounts.set(path, (await deps.source.readFile(path))?.split('\n').length ?? 0);
    return lineCounts.get(path)!;
  };
  const out: ReviewScope[] = [];
  for (const scope of scopes) {
    if (!scope.files || scope.files.length === 0 || scope.focus) {
      out.push(scope);
      continue;
    }
    const ranges: Range[] = [];
    const rangeless: string[] = [];
    for (const path of scope.files) {
      const r = changedRanges(path, await lineCount(path), isChangedLine);
      if (r.length === 0) rangeless.push(path);
      ranges.push(...r);
    }
    const focusParts = packFocus(ranges);
    if (focusParts.length <= 1) {
      out.push(scope);
      continue;
    }
    // Files with no head-side changed lines (deletions, removal-only edits) would belong to no part.
    const parts: { files: string[]; focus?: ScopeFocus[] }[] = [
      ...focusParts.map((focus) => ({ files: [...new Set(focus.map((f) => f.path))], focus })),
      ...(rangeless.length > 0 ? [{ files: rangeless }] : []),
    ];
    parts.forEach(({ files, focus }, i) => {
      out.push({
        ...scope,
        id: i === 0 ? scope.id : deps.newId(),
        part: { index: i + 1, total: parts.length, sectionId: scope.id },
        obligations: scope.obligations.map((o) => (i === 0 ? o : { ...o, id: deps.newId() })),
        files,
        ...(focus ? { focus } : {}),
      });
    });
  }
  return out;
}

export function focusSuffix(focus: readonly ScopeFocus[] | undefined): string {
  if (!focus || focus.length === 0) return '';
  const lines = focus.map((f) => `- ${f.path} lines ${f.startLine}-${f.endLine}`).join('\n');
  return `\n\nThis section is split into parts; this part is responsible for these changed lines:\n${lines}\nGo through every one of these lines. Read beyond them whenever you need context, but check each of these lines against the obligations before you complete the section; other parts cover the rest of the change.`;
}

/** The part of a split section that holds the files whose change only removes lines (no focus ranges). */
export function removalPartSuffix(scope: Pick<ReviewScope, 'part' | 'focus' | 'files'>): string {
  if (!scope.part || (scope.focus && scope.focus.length > 0) || !scope.files?.length) return '';
  return `\n\nThis section is split into parts; this part is responsible for these files, whose change only removes code (deleted files or removal-only edits):\n${scope.files.map((f) => `- ${f}`).join('\n')}\nRead each removal with read_diff and check that nothing left in the repository still depends on what was removed; other parts cover the rest of the change.`;
}

/** Context lines around each focus range in the prefetch. */
const FOCUS_CONTEXT = 20;

export async function prefetchFocus(
  source: SourceProvider,
  focus: readonly ScopeFocus[],
  maxChars: number,
): Promise<string> {
  const blocks: string[] = [];
  let total = 0;
  for (const f of focus) {
    const content = await source.readFile(f.path);
    if (content === null) continue;
    const all = content.split('\n');
    const from = Math.max(1, f.startLine - FOCUS_CONTEXT);
    const to = Math.min(all.length, f.endLine + FOCUS_CONTEXT);
    let body = all
      .slice(from - 1, to)
      .map((text, i) => `${String(from + i).padStart(5)}  ${text}`)
      .join('\n');
    if (total + body.length > maxChars) {
      body = body.slice(0, Math.max(0, maxChars - total));
      blocks.push(`// ${f.path} lines ${from}-${to} (truncated — use read_range for the rest)\n${body}`);
      break;
    }
    total += body.length;
    blocks.push(`// ${f.path} lines ${from}-${to}\n${body}`);
  }
  if (blocks.length === 0) return '';
  return `\n\nThe changed lines this part is responsible for, with surrounding context (line numbers on the left; use read_range/search_code for anything else):\n\n${blocks.join('\n\n')}`;
}
