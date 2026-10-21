import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseUnifiedDiff, type CanonicalDiff } from '@reviewbot/canonical-diff';

const pexec = promisify(execFile);

const DIFF_FLAGS = [
  '--no-color',
  '--find-renames',
  '--find-copies',
  '--full-index',
  '--binary',
  '--no-ext-diff',
];

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Raw UTF-8 paths instead of octal escapes. Paths with quotes/backslashes/control characters are
 * still quoted, so canonical-diff's `unquotePath` handles those.
 */
const QUOTE_PATH_OFF = ['-c', 'core.quotePath=false'];

/**
 * Keep LFS pointers so content does not depend on whether git-lfs is installed, and never download
 * arbitrary files from an LFS server the PR author chose.
 */
const SKIP_LFS_SMUDGE = { GIT_LFS_SKIP_SMUDGE: '1' };

export async function runGit(gitDir: string, args: string[]): Promise<GitResult> {
  const { stdout, stderr } = await pexec('git', ['-C', gitDir, ...QUOTE_PATH_OFF, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
    env: { ...process.env, ...SKIP_LFS_SMUDGE },
  });
  return { stdout, stderr };
}

export async function revParse(gitDir: string, ref: string): Promise<string> {
  const { stdout } = await runGit(gitDir, ['rev-parse', ref]);
  return stdout.trim();
}

/** null when there is no common ancestor. */
export async function mergeBase(gitDir: string, a: string, b: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(gitDir, ['merge-base', a, b]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function diffRange(
  gitDir: string,
  oldRef: string,
  newRef: string,
): Promise<CanonicalDiff> {
  const { stdout } = await runGit(gitDir, ['diff', ...DIFF_FLAGS, oldRef, newRef]);
  const oldSha = await revParse(gitDir, oldRef);
  const newSha = await revParse(gitDir, newRef);
  return parseUnifiedDiff(stdout, { oldSha, newSha });
}

/** diff merge-base(base, head)..head */
export async function diffFromMergeBase(
  gitDir: string,
  baseRef: string,
  headRef: string,
): Promise<{ mergeBaseSha: string | null; diff: CanonicalDiff }> {
  const base = await mergeBase(gitDir, baseRef, headRef);
  const from = base ?? baseRef;
  const diff = await diffRange(gitDir, from, headRef);
  return { mergeBaseSha: base, diff };
}

export async function readFileAtRevision(
  gitDir: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(gitDir, ['show', `${ref}:${path}`]);
    return stdout;
  } catch {
    return null;
  }
}

/**
 * null when a ref is missing locally (force-pushed, shallow clone). `--no-renames` so a rename
 * counts both paths as changed; otherwise a finding on the old path would never be re-verified.
 */
export async function changedFilesBetween(gitDir: string, fromRef: string, toRef: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await runGit(gitDir, [
      'diff',
      '--name-only',
      '--no-renames',
      '--no-color',
      `${fromRef}..${toRef}`,
    ]);
    return new Set(
      stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

export async function hasCommit(gitDir: string, ref: string): Promise<boolean> {
  try {
    await runGit(gitDir, ['cat-file', '-e', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches the PR head ref the provider exposes on the base repository (`refs/pull/<n>/head`,
 * `refs/merge-requests/<n>/head`) rather than cloning the fork: the token may not cover the fork,
 * and the fork URL comes from the (untrusted) event payload.
 * `authedRemoteUrl` is injected with `-c remote.origin.url=` so credentials never land in
 * `.git/config`, which gets copied into sandboxes.
 */
export async function fetchRef(
  gitDir: string,
  remoteRef: string,
  localRef: string,
  authedRemoteUrl?: string,
): Promise<void> {
  await runGit(gitDir, [
    ...(authedRemoteUrl ? ['-c', `remote.origin.url=${authedRemoteUrl}`] : []),
    'fetch',
    '--no-tags',
    '--force',
    'origin',
    `${remoteRef}:${localRef}`,
  ]);
}

export async function addWorktree(gitDir: string, dir: string, ref: string): Promise<void> {
  await runGit(gitDir, ['worktree', 'add', '--detach', '--force', dir, ref]);
}

export async function removeWorktree(gitDir: string, dir: string): Promise<void> {
  await runGit(gitDir, ['worktree', 'remove', '--force', dir]);
}
