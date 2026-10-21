import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { runGit } from '@reviewbot/git-repository';

/**
 * Why a changed file needs no review.
 * - `.gitattributes` linguist attributes are read from the trusted commit, so a PR cannot exempt itself.
 * - Path and header conventions can be forged by the author; skipped files are listed in the summary.
 * - LFS pointer and submodule paths are still passed to the engine, since code using them is reviewed.
 *   Submodules are detected by the workspace via `ls-tree`, not here.
 */
export type SkipReason = 'generated' | 'vendored' | 'binary' | 'lfs-pointer' | 'submodule';

const GENERATED_SUFFIXES = [
  '.g.dart',
  '.freezed.dart',
  '.gr.dart',
  '.mocks.dart',
  '.pb.dart',
  '.pbenum.dart',
  '.pbjson.dart',
  '.pbgrpc.dart',
  '.pb.go',
  '.pb.gw.go',
  '_pb2.py',
  '_pb2_grpc.py',
  '_pb2.pyi',
  '.pb.cc',
  '.pb.h',
  '.designer.cs',
  '.generated.cs',
  '.min.js',
  '.min.css',
  '.js.map',
  '.css.map',
];
const GENERATED_SEGMENTS = new Set(['generated', '__generated__']);
const VENDORED_SEGMENTS = new Set(['vendor', 'third_party', 'node_modules']);
const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'pubspec.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'Podfile.lock',
  'flake.lock',
  'mix.lock',
  'packages.lock.json',
]);

// Only comment lines at the top count: many ordinary files mention these markers elsewhere.
const HEADER_LINES = 5;
const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*|<!--|--|;)/;
const HEADER_MARKERS = [
  /@generated\b/,
  /\bCode generated\b.*\bDO NOT EDIT\b/,
  /\bGENERATED (CODE|FILE)\b.*\bDO NOT (EDIT|MODIFY)\b/i,
  /\bauto-?generated\b.*\bdo not (edit|modify)\b/i,
];
const SNIFF_BYTES = 8192;
const ATTR_BATCH = 200;

export function skipReasonByPath(path: string): SkipReason | undefined {
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? '';
  const dirs = segments.slice(0, -1);
  if (dirs.some((d) => VENDORED_SEGMENTS.has(d))) return 'vendored';
  if (LOCKFILES.has(name)) return 'generated';
  if (dirs.some((d) => GENERATED_SEGMENTS.has(d))) return 'generated';
  if (GENERATED_SUFFIXES.some((s) => name.endsWith(s))) return 'generated';
  return undefined;
}

/**
 * Validates the whole pointer (https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md), not just
 * the first line, or code appended after it would escape review.
 */
const LFS_VERSION = 'version https://git-lfs.github.com/spec/v1';
const LFS_MAX_BYTES = 1024;
function isLfsPointer(head: Buffer): boolean {
  if (head.length >= LFS_MAX_BYTES) return false;
  const lines = head.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return (
    lines[0] === LFS_VERSION &&
    lines.every((l) => /^(version|oid|size|ext-\d+-[a-z0-9]+) [^\s]+$/.test(l)) &&
    lines.some((l) => /^oid sha256:[0-9a-f]{64}$/.test(l)) &&
    lines.some((l) => /^size \d+$/.test(l))
  );
}

export function skipReasonByContent(head: Buffer): SkipReason | undefined {
  if (head.includes(0)) return 'binary';
  if (isLfsPointer(head)) return 'lfs-pointer';
  const lines = head.toString('utf8').split('\n', HEADER_LINES);
  return lines.some((line) => COMMENT_LINE.test(line) && HEADER_MARKERS.some((m) => m.test(line)))
    ? 'generated'
    : undefined;
}

/** Runs outside the sandbox: never follows symlinks or leaves the workspace. */
async function readHead(root: string, path: string): Promise<Buffer | null> {
  try {
    const full = join(root, path);
    const info = await lstat(full);
    if (!info.isFile()) return null;
    const real = await realpath(full);
    if (!real.startsWith(root + sep)) return null;
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** null = explicitly unset: the repo wants it reviewed, overriding path/header heuristics. */
async function attributeReasons(
  gitDir: string,
  baseSha: string,
  paths: readonly string[],
): Promise<Map<string, SkipReason | null>> {
  const out = new Map<string, SkipReason | null>();
  if (paths.length === 0) return out;
  for (let i = 0; i < paths.length; i += ATTR_BATCH) {
    let stdout: string;
    try {
      ({ stdout } = await runGit(gitDir, [
        'check-attr',
        `--source=${baseSha}`,
        '-z',
        'linguist-generated',
        'linguist-vendored',
        '--',
        ...paths.slice(i, i + ATTR_BATCH),
      ]));
    } catch {
      return out;
    }
    const parts = stdout.split('\0');
    for (let j = 0; j + 2 < parts.length; j += 3) {
      const [path, attr, value] = [parts[j]!, parts[j + 1]!, parts[j + 2]!];
      if (value === 'unset' || value === 'false') {
        if (!out.get(path)) out.set(path, null);
      } else if (value === 'set' || value === 'true') {
        if (attr === 'linguist-vendored') out.set(path, 'vendored');
        else if (!out.get(path)) out.set(path, 'generated');
      }
    }
  }
  return out;
}

export interface ClassifyInput {
  paths: readonly string[];
  /** Absent = file headers are not read. */
  headDir?: string;
  /** Both needed for `.gitattributes`. */
  gitDir?: string;
  baseSha?: string;
}

export async function classifyNonReviewable(input: ClassifyInput): Promise<Map<string, SkipReason>> {
  const attrs =
    input.gitDir && input.baseSha
      ? await attributeReasons(input.gitDir, input.baseSha, input.paths)
      : new Map<string, SkipReason | null>();
  const out = new Map<string, SkipReason>();
  const root = input.headDir ? await realpath(input.headDir).catch(() => undefined) : undefined;
  for (const path of input.paths) {
    const attr = attrs.get(path);
    if (attr !== undefined) {
      if (attr !== null) out.set(path, attr);
      continue;
    }
    const byPath = skipReasonByPath(path);
    if (byPath) {
      out.set(path, byPath);
      continue;
    }
    if (!root) continue;
    const head = await readHead(root, path);
    const byContent = head ? skipReasonByContent(head) : undefined;
    if (byContent) out.set(path, byContent);
  }
  return out;
}
