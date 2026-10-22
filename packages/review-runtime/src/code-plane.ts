import type { SubmoduleCheckout } from '@reviewbot/git-repository';
import type { SourceProvider } from '@reviewbot/agent-pi';
import type { ChangedFileEntry } from '@reviewbot/code-intel';
import type { ReviewSkill } from '@reviewbot/prompts';
import type { CommitFileChange } from '@reviewbot/provider-contracts';
import type { ReviewFileState } from './file-state.js';
import type { SkipReason } from './generated-files.js';

/**
 * The control plane never touches a clone: it reads repositories through a workspace on a sandbox
 * host (or in-process), via the same executor. Requests are batched since a sandbox host is ~30 ms away.
 */

export interface WorkspaceInfo {
  changedFiles: ChangedFileEntry[];
  fileStates: ReviewFileState[];
  /** path → head-side changed line numbers. */
  headChangedLines: Record<string, number[]>;
  /** Absent for a tree workspace (no diff). */
  baseSha?: string;
  headSha: string;
  mergeBaseSha: string | null;
  /** Where repository instructions are read from (PR base, stack root, or head for a tree workspace); null = none. */
  trustedSha: string | null;
  /** Changed files that need no review (generated / vendored / binary / LFS pointer), and why. */
  nonReviewable: Record<string, SkipReason>;
  /** Repository skills at `trustedSha`. */
  skills: ReviewSkill[];
  /** Dependency manifests and lockfiles in the head tree (paths only). */
  manifestPaths: string[];
  /** Head-tree submodules and whether they were checked out (only public ones on the same host are). */
  submodules?: SubmoduleCheckout[];
}

export type CodePlaneRequest =
  | { op: 'readFiles'; paths: string[] }
  | { op: 'readTrustedFile'; path: string }
  | { op: 'searchCode'; query: string }
  | { op: 'searchSymbol'; symbol: string }
  | { op: 'changedFilesBetween'; sinceSha: string }
  | { op: 'diffSince'; sinceSha: string; paths: string[]; maxChars: number }
  | { op: 'readPatches'; paths: string[]; maxCharsPerFile: number; maxTotalChars: number }
  | { op: 'findFiles'; names: string[]; maxDepth: number; max: number }
  | { op: 'applyPatch'; patch: string };

export type SearchHit = { path: string; line: number; text: string };

export interface CodePlaneClient {
  /** Head-revision files; null for a missing / unreadable one. */
  readFiles(paths: string[]): Promise<Record<string, string | null>>;
  readTrustedFile(path: string): Promise<string | null>;
  searchCode(query: string): Promise<SearchHit[]>;
  searchSymbol(symbol: string): Promise<SearchHit[]>;
  /** Files changed between `sinceSha` and head; null when `sinceSha` is not in the clone. */
  changedFilesBetween(sinceSha: string): Promise<string[] | null>;
  /** `git diff -U3 sinceSha..head` per path, truncated at `maxChars`; paths without changes omitted. */
  diffSince(sinceSha: string, paths: string[], maxChars: number): Promise<Record<string, string>>;
  /**
   * The change's own patch (merge base..head) per changed path, each truncated at `maxCharsPerFile`;
   * paths past `maxTotalChars` and paths without a patch (tree workspace, unchanged) are omitted.
   */
  readPatches(paths: string[], maxCharsPerFile: number, maxTotalChars: number): Promise<Record<string, string>>;
  /** Head-tree files with these exact names, breadth first (`maxDepth` 0 = root only); skips dependency and VCS dirs. */
  findFiles(names: string[], maxDepth: number, max: number): Promise<string[]>;
  /** Applies a patch to the head worktree in place (later reads see it) and returns the file changes for an API commit. */
  applyPatch(patch: string): Promise<CommitFileChange[]>;
}

export function codePlaneClient(dispatch: (req: CodePlaneRequest) => Promise<unknown>): CodePlaneClient {
  return {
    readFiles: async (paths) => (paths.length === 0 ? {} : ((await dispatch({ op: 'readFiles', paths })) as Record<string, string | null>)),
    readTrustedFile: async (path) => (await dispatch({ op: 'readTrustedFile', path })) as string | null,
    searchCode: async (query) => (await dispatch({ op: 'searchCode', query })) as SearchHit[],
    searchSymbol: async (symbol) => (await dispatch({ op: 'searchSymbol', symbol })) as SearchHit[],
    changedFilesBetween: async (sinceSha) => (await dispatch({ op: 'changedFilesBetween', sinceSha })) as string[] | null,
    diffSince: async (sinceSha, paths, maxChars) =>
      paths.length === 0 ? {} : ((await dispatch({ op: 'diffSince', sinceSha, paths, maxChars })) as Record<string, string>),
    readPatches: async (paths, maxCharsPerFile, maxTotalChars) =>
      paths.length === 0
        ? {}
        : ((await dispatch({ op: 'readPatches', paths, maxCharsPerFile, maxTotalChars })) as Record<string, string>),
    findFiles: async (names, maxDepth, max) => (await dispatch({ op: 'findFiles', names, maxDepth, max })) as string[],
    applyPatch: async (patch) => (await dispatch({ op: 'applyPatch', patch })) as CommitFileChange[],
  };
}

export type WorkspaceLocation =
  | { kind: 'local'; headDir: string; gitDir: string }
  | { kind: 'agent'; host: string; workspaceId: string };

export interface CodePlane {
  info: WorkspaceInfo;
  client: CodePlaneClient;
  location: WorkspaceLocation;
  /** Idempotent. */
  dispose(): Promise<void>;
}

/** Caches head files: a workspace does not change during a job. */
export class CodePlaneReader {
  private readonly cache = new Map<string, Promise<string | null>>();
  private readonly changed: Map<string, Set<number>>;
  readonly source: SourceProvider;

  constructor(
    readonly plane: Pick<CodePlane, 'info' | 'client'>,
    /** The changed-file list agents see (after path filters); defaults to the workspace's. */
    changedFiles: ChangedFileEntry[] = plane.info.changedFiles,
  ) {
    this.changed = new Map(Object.entries(plane.info.headChangedLines).map(([p, ls]) => [p, new Set(ls)]));
    const client = plane.client;
    this.source = {
      listChangedFiles: async () => changedFiles,
      readFile: (path) => this.readFile(path),
      searchCode: (query) => client.searchCode(query),
      searchSymbol: (symbol) => client.searchSymbol(symbol),
    };
  }

  readFile(path: string): Promise<string | null> {
    let hit = this.cache.get(path);
    if (!hit) {
      hit = this.plane.client.readFiles([path]).then((r) => r[path] ?? null);
      this.cache.set(path, hit);
      hit.catch(() => this.cache.delete(path));
    }
    return hit;
  }

  async prefetch(paths: Iterable<string>): Promise<void> {
    const missing = [...new Set(paths)].filter((p) => !this.cache.has(p));
    if (missing.length === 0) return;
    const batch = this.plane.client.readFiles(missing);
    for (const p of missing) {
      const one = batch.then((r) => r[p] ?? null);
      this.cache.set(p, one);
      one.catch(() => this.cache.delete(p));
    }
    await batch;
  }

  readHeadLines = async (path: string): Promise<string[]> => (await this.readFile(path))?.split('\n') ?? [];

  isChangedLine = (path: string, line: number): boolean => this.changed.get(path)?.has(line) ?? false;
}
