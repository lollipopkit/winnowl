import { rm } from 'node:fs/promises';
import {
  changedLinesByPath,
  isChangedLine as isChangedLineIn,
  renderFilePatch,
  type ChangedLines,
} from '@reviewbot/canonical-diff';
import {
  changedFilesFromDiff,
  WorkspaceSourceProvider,
  type ChangedFileEntry,
} from '@reviewbot/code-intel';
import { addWorktree, diffFromMergeBase, readFileAtRevision, removeWorktree, runGit } from '@reviewbot/git-repository';
import { buildReviewFileStates, type ReviewFileState } from './file-state.js';
import { resolveTrustedSha } from './trusted-base.js';

export interface PrepareWorkspaceInput {
  gitDir: string;
  baseSha: string;
  headSha: string;
  headWorktreeDir: string;
  /** Stacked PRs only: repo instructions are read from it (trusted-base.ts). */
  stackRootBranch?: string;
}

export interface PreparedWorkspace {
  source: WorkspaceSourceProvider;
  changedFiles: ChangedFileEntry[];
  fileStates: ReviewFileState[];
  mergeBaseSha: string | null;
  /** `line` is 1-based, head side. */
  isChangedLine: (path: string, line: number) => boolean;
  readHeadLines: (path: string) => Promise<string[]>;
  /**
   * Reads git objects at `trustedSha`, not the worktree (a symlink yields its target string).
   * The only source of repository instructions; null when missing.
   */
  readTrustedFile: (path: string) => Promise<string | null>;
  /** null when the stack root branch is missing: no repo instructions are read. */
  trustedSha: string | null;
  headDir: string;
  cleanup: () => Promise<void>;
  baseSha: string;
  headSha: string;
  /** Serializable form of `isChangedLine` for the code-plane RPC. */
  headChangedLines: Record<string, number[]>;
  /** Unified patch of a changed file (keyed like `changedFiles`); null for an unchanged path. */
  readPatch: (path: string) => string | null;
}

/** Caps on the change's own patches shipped to dig; past them dig reads the head file instead. */
export const PATCH_MAX_CHARS_PER_FILE = 60_000;
export const PATCH_MAX_TOTAL_CHARS = 3_000_000;

/**
 * Patches of `paths`, each truncated at `maxCharsPerFile`; a patch that would pass `maxTotalChars`
 * is left out while smaller later ones still fit.
 */
export function collectPatches(
  readPatch: (path: string) => string | null,
  paths: readonly string[],
  maxCharsPerFile = PATCH_MAX_CHARS_PER_FILE,
  maxTotalChars = PATCH_MAX_TOTAL_CHARS,
): Record<string, string> {
  const out: Record<string, string> = {};
  let total = 0;
  for (const path of paths) {
    const patch = readPatch(path);
    if (patch === null) continue;
    const text =
      patch.length > maxCharsPerFile
        ? `${patch.slice(0, maxCharsPerFile)}\n… (patch truncated; read the file for the rest)`
        : patch;
    if (total + text.length > maxTotalChars) continue;
    total += text.length;
    out[path] = text;
  }
  return out;
}

async function buildPreparedWorkspace(
  input: PrepareWorkspaceInput,
  cleanup: () => Promise<void>,
): Promise<PreparedWorkspace> {
  const { diff, mergeBaseSha } = await diffFromMergeBase(
    input.gitDir,
    input.baseSha,
    input.headSha,
  );
  const fileStates = await buildReviewFileStates({
    gitDir: input.gitDir,
    baselineSha: mergeBaseSha ?? input.baseSha,
    headSha: input.headSha,
    diff,
  });
  const changedFiles = changedFilesFromDiff(diff);
  const changedLines: Map<string, ChangedLines> = changedLinesByPath(diff);
  const source = new WorkspaceSourceProvider(input.headWorktreeDir, changedFiles);
  // Keyed like changedFilesFromDiff, so `readPatch` takes the paths agents see.
  const diffByPath = new Map(diff.files.map((f) => [f.newPath ?? f.oldPath ?? '', f] as const));
  const headChangedLines: Record<string, number[]> = {};
  for (const [path, entry] of changedLines) headChangedLines[path] = [...entry.added];
  const trustedSha = await resolveTrustedSha(input.gitDir, {
    baseSha: input.baseSha,
    ...(input.stackRootBranch !== undefined ? { stackRootBranch: input.stackRootBranch } : {}),
  });

  return {
    source,
    changedFiles,
    fileStates,
    mergeBaseSha,
    isChangedLine: (path, line) => isChangedLineIn(changedLines, path, 'head', line),
    readHeadLines: async (path) => (await source.readFile(path))?.split('\n') ?? [],
    readTrustedFile: (path) =>
      trustedSha === null ? Promise.resolve(null) : readFileAtRevision(input.gitDir, trustedSha, path),
    trustedSha,
    headDir: input.headWorktreeDir,
    cleanup,
    baseSha: input.baseSha,
    headSha: input.headSha,
    headChangedLines,
    readPatch: (path) => {
      const file = diffByPath.get(path);
      return file ? renderFilePatch(file) : null;
    },
  };
}

/** Head worktree plus merge-base diff; repository code is never executed. */
export async function prepareWorkspace(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
  await addWorktree(input.gitDir, input.headWorktreeDir, input.headSha);
  const cleanup = async (): Promise<void> => {
    await removeWorktree(input.gitDir, input.headWorktreeDir).catch(() => undefined);
    await rm(input.headWorktreeDir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    return await buildPreparedWorkspace(input, cleanup);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * No submodule recursion, and the clone disables the ext:: and file:: protocols so a malicious
 * `.gitmodules` cannot run commands or read host files.
 * The returned `origin` carries no credentials: the whole gitDir is copied into sandboxes that run
 * repository code, so later network operations must pass credentials per call.
 */
export async function cloneRepository(
  cloneUrl: string,
  targetDir: string,
  opts: { depth?: number } = {},
): Promise<string> {
  try {
    await runGit(process.cwd(), [
      '-c',
      'protocol.ext.allow=never',
      '-c',
      // `user` allows a local-path clone source (tests) but not nested transports; sealed to `never` below.
      'protocol.file.allow=user',
      'clone',
      '--no-tags',
      ...(opts.depth ? ['--depth', String(opts.depth)] : []),
      cloneUrl,
      targetDir,
    ]);
    await runGit(targetDir, ['config', 'protocol.ext.allow', 'never']);
    await runGit(targetDir, ['config', 'protocol.file.allow', 'never']);
    const safeRemote = cloneUrlWithoutCredentials(cloneUrl);
    if (safeRemote !== cloneUrl)
      await runGit(targetDir, ['remote', 'set-url', 'origin', safeRemote]);
    return targetDir;
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function cloneUrlWithoutCredentials(cloneUrl: string): string {
  try {
    const url = new URL(cloneUrl);
    if (!url.username && !url.password) return cloneUrl;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return cloneUrl;
  }
}

export function authedCloneUrl(cloneUrl: string, token: string): string {
  const url = new URL(cloneUrl);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}
