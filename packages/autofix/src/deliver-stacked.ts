import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { CommitFileChange } from '@reviewbot/provider-contracts';

/**
 * Stacked CR delivery in two halves: where the workspace lives, `applyPatchToTree` +
 * `collectTreeChanges`; on the control plane (which alone holds write credentials),
 * `deliverStackedChangeRequest` commits via the provider API to a bot-namespace branch.
 */
export interface StackedGitResult {
  stdout: string;
  stderr: string;
}

export type RunGit = (dir: string, args: string[]) => Promise<StackedGitResult>;

/** Workflow files are never changed by the bot (no App permission; CI is a supply-chain risk). */
const WORKFLOWS = '.github/workflows/';

/**
 * Applies an LLM patch to a worktree in place. V4A (`*** Begin Patch`) edits by context; unified
 * diffs go through `git apply`, loosened step by step (strict → --3way → --recount). Changes to
 * workflow files are stripped first. Throws when nothing applicable is left or it does not apply.
 */
export async function applyPatchToTree(dir: string, patch: string, runGit: RunGit): Promise<void> {
  if (isStructuredPatch(patch)) {
    // OpenAI models emit V4A, which git apply does not understand: edit by context instead.
    const { files, stripped } = parseStructuredPatch(patch);
    if (files.length === 0) {
      throw new Error(`apply_patch 仅含 workflow 改动(${stripped.join(', ') || '空'})或无支持的操作,无可交付内容`);
    }
    await applyStructuredPatch(dir, files);
    return;
  }
  const { patch: safePatch, stripped } = stripWorkflowChanges(sanitizePatch(patch));
  if (!safePatch.trim()) {
    throw new Error(`patch 仅含 workflow 改动(${stripped.join(', ') || '空'}),按安全策略剔除后无可交付内容`);
  }
  const patchDir = await mkdtemp(join(tmpdir(), 'winnowl-patch-'));
  const patchFile = join(patchDir, 'fix.patch');
  try {
    await writeFile(patchFile, ensureTrailingNewline(safePatch), 'utf8');
    // git apply itself refuses paths outside the tree and paths through symlinks.
    try {
      await runGit(dir, ['apply', '--whitespace=nowarn', patchFile]);
    } catch {
      try {
        await runGit(dir, ['apply', '--3way', '--whitespace=nowarn', patchFile]);
      } catch {
        await runGit(dir, ['apply', '--recount', '--whitespace=fix', patchFile]);
      }
    }
  } finally {
    await rm(patchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Upper bound on the changed content handed back (a fix touches a handful of files). */
const MAX_CHANGE_BYTES = 16 * 1024 * 1024;

/**
 * The worktree's changes against its HEAD, as commit input: every added / modified file with its
 * mode and content, every deleted path. Workflow files are dropped again here (a unified diff
 * without `diff --git` headers is not caught by `stripWorkflowChanges`).
 */
export async function collectTreeChanges(dir: string, runGit: RunGit): Promise<CommitFileChange[]> {
  await runGit(dir, ['add', '-A']);
  const { stdout } = await runGit(dir, ['diff', '--cached', '--raw', '-z', '--no-renames', 'HEAD']);
  const parts = stdout.split('\0');
  const changes: CommitFileChange[] = [];
  let bytes = 0;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    // `:<old mode> <new mode> <old sha> <new sha> <status>` then the path.
    const meta = parts[i]!.replace(/^:/, '').split(' ');
    const path = parts[i + 1]!;
    if (!path || path.startsWith(WORKFLOWS)) continue;
    const status = meta[4] ?? '';
    if (status === 'D') {
      changes.push({ path, deleted: true });
      continue;
    }
    const mode = meta[1];
    if (mode !== '100644' && mode !== '100755' && mode !== '120000') {
      throw new Error(`unsupported file mode ${mode} for ${path}`);
    }
    const abs = join(dir, path);
    const content = mode === '120000' ? Buffer.from(await readlink(abs)) : await readFile(abs);
    bytes += content.length;
    if (bytes > MAX_CHANGE_BYTES) throw new Error(`patch changes more than ${MAX_CHANGE_BYTES} bytes`);
    changes.push({ path, mode, contentBase64: content.toString('base64') });
  }
  return changes;
}

export interface StackedDeliveryDeps {
  /** Commit on base + move the bot branch (production: provider.commits.commitChanges). */
  commitChanges: (input: {
    baseSha: string;
    branch: string;
    message: string;
    author: { name: string; email: string };
    changes: CommitFileChange[];
  }) => Promise<string>;
  /** Production: provider.changes.create with an idempotency key. */
  openChangeRequest: (input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    body: string;
  }) => Promise<{ number: number; url?: string }>;
  /** Revalidate action-plan execution ownership immediately before provider writes. */
  assertLease?: () => Promise<void>;
}

export interface StackedDeliveryInput {
  /** The patched files (`collectTreeChanges`). */
  changes: CommitFileChange[];
  /** From stackedBranchName. */
  branch: string;
  /** Usually the PR head. */
  baseSha: string;
  /** For stacked CRs, the original PR's source branch. */
  targetBranch: string;
  title: string;
  body: string;
  /** Localised markdown appended to the CR body. */
  validationNote?: string;
  /** Required in production: the forge-resolvable bot identity. The fallback email maps to no account. */
  botIdentity?: { name: string; email: string };
}

export interface StackedDeliveryResult {
  branch: string;
  headSha: string;
  changeRequest: { number: number; url?: string };
}

const DEFAULT_BOT = { name: 'winnowl', email: 'winnowl@users.noreply.github.com' };

export async function deliverStackedChangeRequest(
  deps: StackedDeliveryDeps,
  input: StackedDeliveryInput,
): Promise<StackedDeliveryResult> {
  // D-003: the bot only ever writes its own namespace, never the PR's source branch.
  if (!input.branch.startsWith('winnowl/')) throw new Error(`not a bot branch: ${input.branch}`);
  if (input.changes.length === 0) throw new Error('patch 应用后没有可提交的改动');
  await deps.assertLease?.();
  const headSha = await deps.commitChanges({
    baseSha: input.baseSha,
    branch: input.branch,
    message: input.title,
    author: input.botIdentity ?? DEFAULT_BOT,
    changes: input.changes,
  });
  await deps.assertLease?.();
  const cr = await deps.openChangeRequest({
    sourceBranch: input.branch,
    targetBranch: input.targetBranch,
    title: input.title,
    body: input.validationNote ? `${input.body}\n\n${input.validationNote}` : input.body,
  });
  return { branch: input.branch, headSha, changeRequest: cr };
}

function ensureTrailingNewline(patch: string): string {
  return patch.endsWith('\n') ? patch : `${patch}\n`;
}

export interface StructuredFile {
  op: 'update' | 'add';
  path: string;
  hunks: { oldText: string; newText: string }[];
  addContent?: string;
}

export function isStructuredPatch(raw: string): boolean {
  return /^\*\*\* (Begin Patch|Update File:|Add File:|Delete File:)/m.test(raw.replace(/\r\n/g, '\n'));
}

/** Parses V4A into file operations, dropping workflow files. Each hunk keeps oldText/newText for context replacement. */
export function parseStructuredPatch(raw: string): { files: StructuredFile[]; stripped: string[] } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const files: StructuredFile[] = [];
  const stripped: string[] = [];
  let cur: StructuredFile | null = null;
  let hunk: { old: string[]; neu: string[] } | null = null;
  const flushHunk = (): void => {
    if (cur && cur.op === 'update' && hunk && (hunk.old.length || hunk.neu.length)) {
      cur.hunks.push({ oldText: hunk.old.join('\n'), newText: hunk.neu.join('\n') });
    }
    hunk = null;
  };
  const flushFile = (): void => {
    flushHunk();
    if (cur) files.push(cur);
    cur = null;
  };
  for (const line of lines) {
    if (line.startsWith('*** Update File: ') || line.startsWith('*** Add File: ')) {
      flushFile();
      const isAdd = line.startsWith('*** Add File: ');
      const path = line.slice(isAdd ? '*** Add File: '.length : '*** Update File: '.length).trim();
      if (path.startsWith('.github/workflows/')) {
        stripped.push(path);
        cur = null;
      } else {
        cur = isAdd ? { op: 'add', path, hunks: [], addContent: '' } : { op: 'update', path, hunks: [] };
      }
    } else if (line.startsWith('*** Delete File: ')) {
      // Deletions are not supported (rare for fixes); recorded for audit.
      flushFile();
      stripped.push(line.slice('*** Delete File: '.length).trim());
    } else if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      flushFile();
    } else if (line.startsWith('@@')) {
      flushHunk();
      hunk = { old: [], neu: [] };
    } else if (cur) {
      if (cur.op === 'add') {
        if (line.startsWith('+')) cur.addContent = (cur.addContent ? `${cur.addContent}\n` : '') + line.slice(1);
        continue;
      }
      if (!hunk) hunk = { old: [], neu: [] };
      const prefix = line[0];
      const rest = line.slice(1);
      if (prefix === '-') hunk.old.push(rest);
      else if (prefix === '+') hunk.neu.push(rest);
      else {
        // Context or blank line: kept on both sides.
        hunk.old.push(rest);
        hunk.neu.push(rest);
      }
    }
  }
  flushFile();
  return { files, stripped };
}

/**
 * The absolute path of `rel` inside `root`, or an error. Patch paths come from model output, which
 * PR content can steer: `../x`, absolute paths, `.git/…` and paths through a symlink that leads out
 * of the tree are refused (the last check runs on the nearest existing ancestor).
 */
export async function safeTreePath(root: string, rel: string): Promise<string> {
  const clean = normalize(rel);
  if (!rel || isAbsolute(rel) || clean === '..' || clean.startsWith(`..${sep}`) || clean.split(sep).includes('..')) {
    throw new Error(`patch path escapes the tree: ${rel}`);
  }
  if (clean === '.git' || clean.startsWith(`.git${sep}`)) throw new Error(`patch path inside .git: ${rel}`);
  const realRoot = await realpath(root);
  let probe = join(realRoot, clean);
  for (;;) {
    const st = await lstat(probe).catch(() => null);
    if (st) break;
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const resolved = await realpath(probe);
  const inside = relative(realRoot, resolved);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`patch path leaves the tree via a symlink: ${rel}`);
  return join(realRoot, clean);
}

async function applyStructuredPatch(dir: string, files: StructuredFile[]): Promise<void> {
  for (const f of files) {
    const abs = await safeTreePath(dir, f.path);
    if (f.op === 'add') {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, ensureTrailingNewline(f.addContent ?? ''), 'utf8');
      continue;
    }
    let content = await readFile(abs, 'utf8');
    for (const h of f.hunks) {
      if (content.includes(h.oldText)) {
        content = content.replace(h.oldText, h.newText);
        continue;
      }
      // LLM context often differs in indentation/trailing whitespace: fall back to a trimmed line match.
      const fuzzy = fuzzyReplaceBlock(content, h.oldText, h.newText);
      if (fuzzy === null) {
        throw new Error(`apply_patch: 无法在 ${f.path} 定位待修改上下文`);
      }
      content = fuzzy;
    }
    await writeFile(abs, content, 'utf8');
  }
}

/** Replaces the block whose lines equal oldText's after trimming; null when not found. */
export function fuzzyReplaceBlock(content: string, oldText: string, newText: string): string | null {
  const contentLines = content.split('\n');
  const oldLines = oldText.split('\n');
  if (oldLines.length === 0) return null;
  const norm = (s: string): string => s.trim();
  for (let i = 0; i + oldLines.length <= contentLines.length; i += 1) {
    let match = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (norm(contentLines[i + j]!) !== norm(oldLines[j]!)) {
        match = false;
        break;
      }
    }
    if (match) {
      return [...contentLines.slice(0, i), ...newText.split('\n'), ...contentLines.slice(i + oldLines.length)].join('\n');
    }
  }
  return null;
}

/**
 * Normalises line endings, strips markdown fences and any preamble before the first diff header,
 * which otherwise make git apply fail with "No valid patches in input".
 */
export function sanitizePatch(raw: string): string {
  let s = raw.replace(/\r\n/g, '\n');
  const fence = s.match(/```(?:diff|patch)?\n([\s\S]*?)```/);
  if (fence?.[1]) s = fence[1];
  const start = s.search(/^(diff --git |--- |Index: )/m);
  if (start > 0) s = s.slice(start);
  return s.trim();
}

/** Drops `.github/workflows/` sections (split on `diff --git`) and returns the removed paths. */
export function stripWorkflowChanges(patch: string): { patch: string; stripped: string[] } {
  const parts = patch.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  const stripped: string[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const m = part.match(/^diff --git a\/(\S+) b\/(\S+)/m);
    const path = m?.[2] ?? m?.[1] ?? '';
    if (path.startsWith('.github/workflows/')) {
      stripped.push(path);
    } else {
      kept.push(part);
    }
  }
  return { patch: kept.join(''), stripped };
}
