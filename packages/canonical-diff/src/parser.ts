import { contentHash, detectLanguage, isGeneratedPath, normalizeLine } from './normalize.js';
import type { CanonicalDiff, DiffFile, DiffHunk, DiffLine, DiffLineKind } from './types.js';

export interface ParseOptions {
  oldSha?: string;
  newSha?: string;
}

/**
 * Unquotes git's C-style quoted paths. `core.quotePath=false` only covers non-ASCII; quotes and
 * backslashes are always escaped. Octal escapes are per byte, so collect bytes and decode as UTF-8.
 */
const SIMPLE_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 0x5c, '"': 0x22 };

export function unquotePath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const enc = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...enc.encode(c));
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) break; // trailing lone backslash: drop
    i += 1;
    const simple = SIMPLE_ESCAPES[n];
    if (simple !== undefined) {
      bytes.push(simple);
      continue;
    }
    if (n >= '0' && n <= '7') {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8) & 0xff);
      i += 2;
      continue;
    }
    bytes.push(...enc.encode(n)); // unknown escape: keep the character
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(p: string): string {
  const raw = unquotePath(p.trim());
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function newDiffFile(): DiffFile {
  return {
    status: 'modified',
    hunks: [],
    isGenerated: false,
    isBinary: false,
    additions: 0,
    deletions: 0,
  };
}

function makeLine(
  kind: DiffLineKind,
  oldLine: number | undefined,
  newLine: number | undefined,
  patchLine: number,
  content: string,
): DiffLine {
  const normalized = normalizeLine(content);
  const line: DiffLine = {
    kind,
    patchLine,
    raw: content,
    normalized,
    contentHash: contentHash(normalized),
  };
  if (oldLine !== undefined) line.oldLine = oldLine;
  if (newLine !== undefined) line.newLine = newLine;
  return line;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiff(text: string, options: ParseOptions = {}): CanonicalDiff {
  const lines = text.split('\n');
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let position = 0;
  let oldLineNo = 0;
  let newLineNo = 0;

  const finalize = (file: DiffFile): DiffFile => {
    const path = file.newPath ?? file.oldPath;
    if (path) {
      file.isGenerated = isGeneratedPath(path);
      const lang = detectLanguage(path);
      if (lang) file.language = lang;
    }
    if (file.isBinary && file.status === 'modified') file.status = 'binary';
    return file;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(finalize(current));
      current = newDiffFile();
      hunk = null;
      position = 0;
      // `diff --git a/x b/x`, or `diff --git "a/x" "b/x"` when the path needs escaping.
      const m = /^diff --git (".*?"|\S+) (".*?"|\S+)$/.exec(line);
      if (m && m[1] && m[2]) {
        current.oldPath = stripPrefix(m[1]);
        current.newPath = stripPrefix(m[2]);
      }
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = unquotePath(line.slice('rename from '.length).trim());
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newPath = unquotePath(line.slice('rename to '.length).trim());
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('copy from ')) {
      current.oldPath = unquotePath(line.slice('copy from '.length).trim());
      current.status = 'copied';
      continue;
    }
    if (line.startsWith('copy to ')) {
      current.newPath = unquotePath(line.slice('copy to '.length).trim());
      current.status = 'copied';
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.isBinary = true;
      continue;
    }
    if (
      line.startsWith('index ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('dissimilarity index')
    ) {
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p === '/dev/null') {
        delete current.oldPath;
        current.status = 'added';
      } else {
        current.oldPath = stripPrefix(p);
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p === '/dev/null') {
        delete current.newPath;
        current.status = 'deleted';
      } else {
        current.newPath = stripPrefix(p);
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const hm = HUNK_RE.exec(line);
      if (hm) {
        hunk = {
          oldStart: Number(hm[1] ?? 0),
          oldLines: hm[2] ? Number(hm[2]) : 1,
          newStart: Number(hm[3] ?? 0),
          newLines: hm[4] ? Number(hm[4]) : 1,
          heading: (hm[5] ?? '').trim(),
          lines: [],
        };
        current.hunks.push(hunk);
        oldLineNo = hunk.oldStart;
        newLineNo = hunk.newStart;
        if (current.hunks.length > 1) position += 1; // later @@ headers also take a position
      }
      continue;
    }
    if (hunk) {
      const marker = line[0];
      if (marker === '\\') continue; // \ No newline at end of file
      // non-hunk line (trailing newline, or the hunk has ended)
      if (marker !== ' ' && marker !== '+' && marker !== '-') continue;
      position += 1;
      const content = line.slice(1);
      if (marker === '+') {
        hunk.lines.push(makeLine('added', undefined, newLineNo, position, content));
        newLineNo += 1;
        current.additions += 1;
      } else if (marker === '-') {
        hunk.lines.push(makeLine('deleted', oldLineNo, undefined, position, content));
        oldLineNo += 1;
        current.deletions += 1;
      } else {
        hunk.lines.push(makeLine('context', oldLineNo, newLineNo, position, content));
        oldLineNo += 1;
        newLineNo += 1;
      }
    }
  }
  if (current) files.push(finalize(current));

  const additions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);

  return {
    oldSha: options.oldSha ?? '',
    newSha: options.newSha ?? '',
    files,
    stats: { filesChanged: files.length, additions, deletions },
  };
}
