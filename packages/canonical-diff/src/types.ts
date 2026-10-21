export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'binary';

export type DiffLineKind = 'context' | 'added' | 'deleted';

export interface DiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  /** GitHub position semantics: the first line after the first @@ is 1. */
  patchLine: number;
  raw: string;
  normalized: string;
  contentHash: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath?: string;
  newPath?: string;
  status: DiffFileStatus;
  hunks: DiffHunk[];
  isGenerated: boolean;
  isBinary: boolean;
  language?: string;
  additions: number;
  deletions: number;
}

export interface DiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface CanonicalDiff {
  oldSha: string;
  newSha: string;
  files: DiffFile[];
  stats: DiffStats;
}
