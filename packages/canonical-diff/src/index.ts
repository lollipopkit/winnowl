export type {
  CanonicalDiff,
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffStats,
  DiffFileStatus,
  DiffLineKind,
} from './types.js';

export { parseUnifiedDiff, unquotePath } from './parser.js';
export type { ParseOptions } from './parser.js';

export { changedLinesByPath, isChangedLine } from './changed-lines.js';
export type { ChangedLines } from './changed-lines.js';

export { normalizeLine, contentHash, isGeneratedPath, detectLanguage } from './normalize.js';
