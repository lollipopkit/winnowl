import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface SubmoduleCheckout {
  path: string;
  sha: string;
  status: 'checked-out' | 'skipped';
  /** Never contains credentials. */
  reason?: string;
  /** From `SubmoduleOptions.previous`. */
  previousSha?: string;
  /** Absent without a previous pin, when skipped, or when the previous commit could not be fetched. */
  changes?: { files: SubmoduleFileChange[]; total: number };
}

export interface SubmoduleFileChange {
  /** git's name-status letter: A / M / D / R / C / T. */
  status: string;
  path: string;
}

export interface SubmoduleOptions {
  /** Most submodules checked out; the rest are skipped. Default 16. */
  max?: number;
  /** Per submodule fetch + checkout. Default 120 s. */
  timeoutMs?: number;
  /** Submodules fetched at once. Default 4. */
  concurrency?: number;
  /** Gitlink path -> commit pinned before the change; moved ones get `SubmoduleCheckout.changes`. */
  previous?: ReadonlyMap<string, string>;
  /** Most changed files listed per submodule. Default 200. */
  maxChangedFiles?: number;
}

/**
 * One level, pinned commit only, depth 1. `.gitmodules` is untrusted (fork PRs):
 * - only anonymous https fetches from the repository's own host (no token, so private ones are skipped);
 * - no redirects, prompts, LFS or nesting; count and time are capped;
 * - the target must be the empty gitlink directory inside the worktree.
 * Failures are skipped and reported, never fatal.
 */
export async function checkoutSubmodules(
  worktree: string,
  repositoryUrl: string,
  opts: SubmoduleOptions = {},
): Promise<SubmoduleCheckout[]> {
  const gitlinks = await listGitlinks(worktree);
  if (gitlinks.length === 0) return [];
  const urls = await submoduleUrls(worktree);
  const max = opts.max ?? 16;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const results: SubmoduleCheckout[] = [];
  const queue = gitlinks.map((g, i) => async (): Promise<void> => {
    if (i >= max) {
      results.push({ ...g, status: 'skipped', reason: `more than ${max} submodules` });
      return;
    }
    const previous = opts.previous?.get(g.path);
    const out = await checkoutOne(worktree, repositoryUrl, g, urls.get(g.path), timeoutMs, previous, opts.maxChangedFiles);
    results.push(previous !== undefined && previous !== g.sha ? { ...out, previousSha: previous } : out);
  });
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 4, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await job();
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function checkoutOne(
  worktree: string,
  repositoryUrl: string,
  link: { path: string; sha: string },
  rawUrl: string | undefined,
  timeoutMs: number,
  previous: string | undefined,
  maxChangedFiles: number | undefined,
): Promise<SubmoduleCheckout> {
  const skip = (reason: string): SubmoduleCheckout => ({ ...link, status: 'skipped', reason });
  if (!rawUrl) return skip('not listed in .gitmodules');
  const url = submoduleFetchUrl(rawUrl, repositoryUrl);
  if (!url) return skip('URL is not https on the repository host');
  const target = await gitlinkTarget(worktree, link.path);
  if (!target) return skip('path is not an empty directory inside the worktree');
  const git = (cwd: string, args: string[]) =>
    pexec('git', ['-C', cwd, ...HARDENED, ...args], { timeout: timeoutMs, env: GIT_ENV, maxBuffer: 4 * 1024 * 1024 });
  try {
    await git(target, ['init', '-q']);
    await git(target, ['fetch', '-q', '--no-tags', '--depth', '1', url, link.sha]);
    await git(target, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', 'FETCH_HEAD']);
    const { stdout } = await git(target, ['rev-parse', 'HEAD']);
    if (stdout.trim() !== link.sha) throw new Error('fetched commit differs from the pinned one');
    if (previous === undefined || previous === link.sha || !/^[0-9a-f]{40,64}$/.test(previous)) {
      return { ...link, status: 'checked-out' };
    }
    // Only a listing is lost when the old pin is gone (force-pushed submodule): never fail the checkout.
    const fetched = await git(target, ['fetch', '-q', '--no-tags', '--depth', '1', url, previous]).then(
      () => true,
      () => false,
    );
    const changes = fetched ? await submoduleChanges(target, previous, link.sha, maxChangedFiles ?? 200, timeoutMs) : null;
    return { ...link, status: 'checked-out', ...(changes ? { changes } : {}) };
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(target, { recursive: true }).catch(() => undefined);
    if ((error as { killed?: boolean }).killed) return skip('timed out');
    // git's stderr names the URL, which never carries credentials here.
    const last = ((error as { stderr?: string }).stderr ?? (error as Error).message).trim().split('\n').at(-1) ?? '';
    // An anonymous fetch of a private repository asks for a username, which is disabled.
    return skip(/could not read Username|not found|Authentication failed/i.test(last) ? 'private or missing' : `fetch failed: ${last}`);
  }
}

/**
 * Files that differ between two commits of a checked-out submodule. Both commits only need their
 * trees (depth-1 fetches are enough); null when either is missing.
 */
export async function submoduleChanges(
  dir: string,
  fromSha: string,
  toSha: string,
  max = 200,
  timeoutMs = 120_000,
): Promise<{ files: SubmoduleFileChange[]; total: number } | null> {
  try {
    const { stdout } = await pexec(
      'git',
      ['-C', dir, ...HARDENED, 'diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', fromSha, toSha, '--'],
      { timeout: timeoutMs, env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 },
    );
    const parts = stdout.split('\0');
    if (parts.at(-1) === '') parts.pop();
    const files: SubmoduleFileChange[] = [];
    let total = 0;
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++]!.charAt(0);
      // Renames and copies carry two paths; the new one is what the superproject would use.
      if (status === 'R' || status === 'C') i++;
      const path = parts[i++];
      if (path === undefined) break;
      total++;
      if (files.length < max) files.push({ status, path });
    }
    return { files, total };
  } catch {
    return null;
  }
}

export async function gitlinksAt(gitDir: string, rev: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const g of await listGitlinks(gitDir, rev)) out.set(g.path, g.sha);
  return out;
}

const HARDENED = [
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'http.followRedirects=false',
  '-c', 'credential.helper=',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'submodule.recurse=false',
];
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'true',
  GIT_LFS_SKIP_SMUDGE: '1',
};

/** null unless https on the repository's host and port without credentials; relative URLs resolve like git. */
export function submoduleFetchUrl(raw: string, repositoryUrl: string): string | null {
  let repo: URL;
  try {
    repo = new URL(repositoryUrl);
  } catch {
    return null;
  }
  let url: URL;
  try {
    url = raw.startsWith('./') || raw.startsWith('../')
      ? new URL(raw, `${repo.origin}${repo.pathname.replace(/\/+$/, '')}/`)
      : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || repo.protocol !== 'https:') return null;
  if (url.hostname.toLowerCase() !== repo.hostname.toLowerCase() || url.port !== repo.port) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.toString();
}

async function listGitlinks(worktree: string, rev = 'HEAD'): Promise<{ path: string; sha: string }[]> {
  const { stdout } = await pexec('git', ['-C', worktree, 'ls-tree', '-r', '-z', rev], { maxBuffer: 64 * 1024 * 1024 });
  const out: { path: string; sha: string }[] = [];
  for (const entry of stdout.split('\0')) {
    const m = /^160000 commit ([0-9a-f]{40,64})\t(.+)$/s.exec(entry);
    if (m) out.push({ sha: m[1]!, path: m[2]! });
  }
  return out;
}

async function submoduleUrls(worktree: string): Promise<Map<string, string>> {
  const file = join(worktree, '.gitmodules');
  const st = await lstat(file).catch(() => null);
  if (!st?.isFile() || st.size > 256 * 1024) return new Map();
  // git's own parser, on that file only: --no-includes keeps an `[include]` from reading others.
  const { stdout } = await pexec(
    'git',
    ['config', '--file', file, '--no-includes', '-z', '--get-regexp', '^submodule\\..*\\.(path|url)$'],
    { env: GIT_ENV },
  ).catch(() => ({ stdout: '' }));
  const byName = new Map<string, { path?: string; url?: string }>();
  for (const entry of stdout.split('\0')) {
    const m = /^submodule\.(.+)\.(path|url)\n(.*)$/s.exec(entry);
    if (!m) continue;
    const cur = byName.get(m[1]!) ?? {};
    cur[m[2] as 'path' | 'url'] = m[3]!;
    byName.set(m[1]!, cur);
  }
  const out = new Map<string, string>();
  for (const { path, url } of byName.values()) if (path && url) out.set(normalize(path).replace(/\/+$/, ''), url);
  return out;
}

/** The directory git created for a gitlink: inside the worktree, a real (non-symlink) empty dir. */
async function gitlinkTarget(worktree: string, path: string): Promise<string | null> {
  if (isAbsolute(path) || normalize(path).split(sep).includes('..')) return null;
  // Every component must be a real directory: a symlinked parent could lead outside the worktree.
  let dir = worktree;
  for (const part of normalize(path).split(sep)) {
    dir = join(dir, part);
    const st = await lstat(dir).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
  }
  return (await readdir(dir)).length === 0 ? dir : null;
}
