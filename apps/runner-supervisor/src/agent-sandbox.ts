import { posix } from 'node:path';
import type { SourceProvider } from '@reviewbot/agent-pi';
import {
  previousCommands,
  recordCommandDecision,
  recordCommandResult,
  reviewCommand,
  type CommandAuditScope,
  type CommandOutcome,
  type JudgeDeps,
} from '@reviewbot/command-gate';
import type { Db } from '@reviewbot/db';
import type { ExecResult, SandboxBackend, SandboxHandle, SandboxSpec, SandboxUsage } from '@reviewbot/sandbox';
import { growAfterFailure, peaksOf, ranOutOfDisk, recordSizing, swapFor, type SizeBounds } from './sandbox-sizing.js';

/**
 * An agent's sandbox: a writable copy of the repository with its toolchains, driven from the control
 * plane. The agent's loop, its keys and the command gate stay out here; the sandbox only ever receives
 * commands that passed the gate.
 *
 * Elastic: it idles small and grows to `workMemoryMb` before a command (waiting for host room like a
 * create); 60 s after the last command it stops leftovers and shrinks back. A command killed for want of
 * memory or disk grows it and runs once more. The tree starts as a git repository (a baseline commit),
 * so the change is `git diff`.
 */
export interface AgentSandboxOptions {
  backend: SandboxBackend;
  /** Image, network, env, placement; resources are set here from the sizes below. */
  spec: SandboxSpec;
  /** Puts the repository's head tree at `dest`. */
  deliverTree: (handle: SandboxHandle, dest: string) => Promise<void>;
  /** Idle size and the size commands run at. */
  base: { cpus: number; memoryMb: number };
  work: { cpus: number; memoryMb: number };
  diskMb: number;
  bounds: SizeBounds;
  /** What the commands are reviewed against (the judge sees this, never repository content). */
  task: string;
  judge?: JudgeDeps;
  /** Audit and sizing records; absent in tests without a database. */
  db?: Db;
  audit?: CommandAuditScope;
  sizing?: { tenantId: string; repositoryId: string };
  idleShrinkMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export const REPO_DIR = '/workspace/repo';
const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = 1800;
const OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const SEARCH_HITS = 50;
const SYMBOL_HITS = 200;
const SKIP_DIRS = ['.git', 'node_modules', 'dist', 'build', 'target', '.dart_tool'];
const GIT_ID = ['-c', 'user.name=winnowl', '-c', 'user.email=agent@winnowl.invalid', '-c', 'commit.gpgsign=false'];

export class AgentSandbox {
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;
  private memoryMb: number;
  private closed = false;
  /** Files the agent wrote through the edit tools: the change is these, nothing a command left. */
  private readonly touched = new Set<string>();

  private constructor(
    private readonly o: AgentSandboxOptions,
    readonly handle: SandboxHandle,
  ) {
    this.memoryMb = o.base.memoryMb;
  }

  static async open(o: AgentSandboxOptions): Promise<AgentSandbox> {
    const spec: SandboxSpec = {
      ...o.spec,
      resources: {
        ...o.spec.resources,
        cpus: o.base.cpus,
        memoryMb: o.base.memoryMb,
        swapMb: swapFor(o.base.memoryMb),
        diskMb: o.diskMb,
        workspace: 'disk',
      },
      writableExec: true,
    };
    const handle = await o.backend.create(spec);
    const box = new AgentSandbox(o, handle);
    try {
      await o.deliverTree(handle, REPO_DIR);
      await box.baseline();
    } catch (err) {
      await o.backend.destroy(handle).catch(() => undefined);
      throw err;
    }
    return box;
  }

  /** A git repository of the delivered tree (worktree and submodule `.git` files point nowhere here). */
  private async baseline(): Promise<void> {
    const script = [
      'set -e',
      'find . -name .git -type f -delete',
      'git init -q',
      'git add -A',
      `git ${GIT_ID.join(' ')} commit -q --no-verify --allow-empty -m baseline`,
    ].join('\n');
    const r = await this.exec(['sh', '-c', script], 10 * 60_000);
    if (r.exitCode !== 0) throw new Error(`could not prepare the sandbox repository: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  }

  /** A platform-decided command (no gate): reads, searches, git. */
  private exec(argv: string[], timeoutMs = 60_000, maxOutputBytes = OUTPUT_BYTES): Promise<ExecResult> {
    return this.o.backend.exec(this.handle, { argv, cwd: REPO_DIR, purpose: 'inspect', timeoutMs, maxOutputBytes });
  }

  /** Reads and searches inside the sandbox: what the agent sees includes its own edits. */
  source(changed: readonly string[]): SourceProvider {
    const search = async (flags: string[], grepFlags: string, query: string, max: number) => {
      const skip = SKIP_DIRS.flatMap((d) => ['-g', `!${d}`]);
      let r = await this.exec(['rg', ...flags, '--line-number', '--no-heading', '--color', 'never', '--max-columns', '500', ...skip, '--', query, '.'], 60_000, 1024 * 1024);
      if (r.exitCode === 127 || r.exitCode === 126) {
        // An image without ripgrep.
        const exclude = SKIP_DIRS.map((d) => `--exclude-dir=${d}`);
        r = await this.exec(['grep', '-rnI', grepFlags, ...exclude, '--', query, '.'], 60_000, 1024 * 1024);
      }
      if (r.exitCode !== 0) return [];
      const hits: { path: string; line: number; text: string }[] = [];
      for (const line of r.stdout.split('\n')) {
        if (hits.length >= max) break;
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (m) hits.push({ path: m[1]!.replace(/^\.\//, ''), line: Number(m[2]), text: m[3]!.trim().slice(0, 500) });
      }
      return hits;
    };
    return {
      listChangedFiles: async () => changed.map((path) => ({ path, status: 'modified' })),
      readFile: async (path) => {
        const rel = repoPath(path);
        if (!rel) return null;
        const r = await this.exec(['cat', '--', rel], 30_000);
        return r.exitCode === 0 ? r.stdout : null;
      },
      searchCode: (query) => search(['--fixed-strings', '--ignore-case'], '-Fi', query, SEARCH_HITS),
      searchSymbol: async (symbol) =>
        /^[A-Za-z_$][\w$]*$/.test(symbol) ? search(['--fixed-strings', '--word-regexp', '--case-sensitive'], '-Fw', symbol, SYMBOL_HITS) : [],
    };
  }

  /** Whether a directory of the repository exists. */
  async isDir(path: string): Promise<boolean> {
    const rel = repoPath(path);
    return rel !== null && (await this.exec(['test', '-d', rel], 15_000)).exitCode === 0;
  }

  /** Writes a file of the repository (creating its directories). */
  async writeFile(path: string, content: string): Promise<void> {
    const rel = repoPath(path);
    if (!rel) throw new Error(`not a path inside the repository: ${path}`);
    const abs = posix.join(REPO_DIR, rel);
    const mk = await this.exec(['mkdir', '-p', '--', posix.dirname(abs)]);
    if (mk.exitCode !== 0) throw new Error(`cannot create ${posix.dirname(rel)}: ${mk.stderr.trim()}`);
    await this.o.backend.putFile(this.handle, { path: abs, content });
    this.touched.add(rel);
  }

  /**
   * Runs an agent's command: the gate decides (rules, then the judge), the decision is recorded,
   * an allowed command runs at the work size. Commands run one at a time.
   */
  runCommand(command: string, opts: { purpose?: string; timeoutSec?: number } = {}): Promise<CommandOutcome> {
    const run = this.chain.then(() => this.runCommandNow(command, opts));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runCommandNow(command: string, opts: { purpose?: string; timeoutSec?: number }): Promise<CommandOutcome> {
    if (this.closed) throw new Error('the sandbox is closed');
    this.cancelShrink();
    const { db, audit } = this.o;
    const previous = db && audit?.jobId ? await previousCommands(db, audit.jobId).catch(() => []) : [];
    const decision = await reviewCommand(
      command,
      { task: this.o.task, ...(opts.purpose ? { purpose: opts.purpose } : {}), previous },
      this.o.judge,
    );
    const auditId = db && audit ? await recordCommandDecision(db, audit, { command, ...(opts.purpose ? { purpose: opts.purpose } : {}) }, decision).catch(() => undefined) : undefined;
    if (decision.verdict === 'deny') return { decision };
    try {
      if (!(await this.ensureWorkSize())) {
        return { decision, notRun: 'the sandbox host has no room to run commands right now; continue without running it, or try again later' };
      }
      const timeoutMs = Math.min(MAX_TIMEOUT_SEC, Math.max(10, opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC)) * 1000;
      const execute = () =>
        this.o.backend.exec(this.handle, { argv: ['sh', '-lc', command], cwd: REPO_DIR, purpose: 'confirm', timeoutMs, maxOutputBytes: OUTPUT_BYTES });
      let result = await execute();
      let retried = false;
      if (result.exitCode !== 0 && !result.timedOut && (await this.growAfter(result))) {
        result = await execute();
        retried = true;
      }
      if (db && auditId) {
        await recordCommandResult(db, auditId, {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          ...(result.oomKilled ? { oomKilled: true } : {}),
          durationMs: result.durationMs,
        }).catch(() => undefined);
      }
      return { decision, result, ...(retried ? { retried } : {}) };
    } finally {
      this.scheduleShrink();
    }
  }

  /** Validation commands chosen by the platform (not the agent): no gate, same sizing. */
  async runPlatform(
    argv: string[],
    timeoutMs: number,
    purpose: 'build' | 'lint' | 'test' | 'bootstrap' | 'autofix-validation',
    /** Repository-relative directory to run in (a project of a monorepo); default the root. */
    dir = '',
  ): Promise<ExecResult> {
    const cwd = dir ? posix.join(REPO_DIR, repoPath(dir) ?? '.') : REPO_DIR;
    const run = this.chain.then(async () => {
      this.cancelShrink();
      try {
        await this.ensureWorkSize();
        const execute = () => this.o.backend.exec(this.handle, { argv, cwd, purpose, timeoutMs, maxOutputBytes: OUTPUT_BYTES });
        let r = await execute();
        if (r.exitCode !== 0 && !r.timedOut && (await this.growAfter(r))) r = await execute();
        return r;
      } finally {
        this.scheduleShrink();
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async growAfter(r: ExecResult): Promise<boolean> {
    const grew = await growAfterFailure(
      this.o.backend,
      this.handle,
      { oomKilled: r.oomKilled === true, outOfDisk: ranOutOfDisk(`${r.stdout}\n${r.stderr}`) },
      this.o.bounds,
    ).catch(() => false);
    if (grew && this.o.backend.usage) this.memoryMb = (await this.o.backend.usage(this.handle).catch(() => undefined))?.memoryMb ?? this.memoryMb;
    return grew;
  }

  /** Grows to the work size before a command; false when the host had no room in time. */
  private async ensureWorkSize(): Promise<boolean> {
    if (!this.o.backend.resize || this.memoryMb >= this.o.work.memoryMb) return true;
    try {
      const u = await this.o.backend.resize(this.handle, {
        memoryMb: this.o.work.memoryMb,
        swapMb: swapFor(this.o.work.memoryMb),
        cpus: this.o.work.cpus,
      });
      this.memoryMb = u.memoryMb;
      return true;
    } catch (err) {
      this.o.log?.('agent sandbox could not grow for a command', { err: (err as Error).message });
      return false;
    }
  }

  private cancelShrink(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** After a quiet spell: stop leftovers and give the work size back to the host. */
  private scheduleShrink(): void {
    this.cancelShrink();
    if (!this.o.backend.resize || this.memoryMb <= this.o.base.memoryMb) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      const shrink = this.chain.then(async () => {
        if (this.closed || this.memoryMb <= this.o.base.memoryMb) return;
        try {
          const u = await this.o.backend.resize!(this.handle, {
            memoryMb: this.o.base.memoryMb,
            swapMb: swapFor(this.o.base.memoryMb),
            cpus: this.o.base.cpus,
            stopProcesses: true,
          });
          this.memoryMb = u.memoryMb;
        } catch (err) {
          this.o.log?.('agent sandbox could not shrink', { err: (err as Error).message });
        }
      });
      this.chain = shrink.catch(() => undefined);
    }, this.o.idleShrinkMs ?? 60_000);
    this.idleTimer.unref?.();
  }

  /**
   * The change against the delivered tree: the files the agent wrote with the edit tools. What
   * commands changed besides (a lockfile `npm install` wrote, generated code, a formatter's
   * rewrites of other files) is not part of it.
   */
  async diff(): Promise<string> {
    await this.chain;
    if (this.touched.size === 0) return '';
    const paths = ['--', ...[...this.touched].sort()];
    const add = await this.exec(['git', 'add', '-A', ...paths], 120_000);
    if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr.trim().slice(0, 500)}`);
    const r = await this.exec(['git', '-c', 'core.quotepath=off', 'diff', '--cached', '--no-color', '--no-ext-diff', ...paths], 120_000, MAX_DIFF_BYTES + 1);
    if (r.exitCode !== 0) throw new Error(`git diff failed: ${r.stderr.trim().slice(0, 500)}`);
    if (r.stdoutTruncated) throw new Error(`the change is larger than ${MAX_DIFF_BYTES / 1024 / 1024} MiB`);
    return r.stdout;
  }

  /**
   * Puts the tree back to the baseline plus the agent's change: tracked files only commands
   * changed are restored, untracked files they created (not ignored ones like node_modules) are
   * removed. Validation then sees what is delivered.
   */
  async keepOnlyTheChange(): Promise<void> {
    await this.chain;
    const list = async (argv: string[]): Promise<string[]> => {
      const r = await this.exec(argv, 120_000);
      if (r.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} failed: ${r.stderr.trim().slice(0, 300)}`);
      return r.stdout.split('\0').filter((p) => p && !this.touched.has(p));
    };
    const changed = await list(['git', '-c', 'core.quotepath=off', 'diff', '--name-only', '-z', 'HEAD']);
    const untracked = await list(['git', 'ls-files', '-z', '--others', '--exclude-standard']);
    for (let i = 0; i < changed.length; i += 200) {
      await this.exec(['git', 'checkout', 'HEAD', '--', ...changed.slice(i, i + 200)], 120_000);
    }
    for (let i = 0; i < untracked.length; i += 200) {
      await this.exec(['rm', '-f', '--', ...untracked.slice(i, i + 200)], 120_000);
    }
  }

  /** Records what the sandbox needed and removes it. */
  async close(): Promise<SandboxUsage | undefined> {
    if (this.closed) return undefined;
    this.cancelShrink();
    await this.chain.catch(() => undefined);
    this.closed = true;
    let usage: SandboxUsage | undefined;
    try {
      usage = await this.o.backend.usage?.(this.handle);
      if (usage && this.o.db && this.o.sizing) await recordSizing(this.o.db, { ...this.o.sizing, kind: 'agent' }, peaksOf(usage));
    } catch {
      // Bookkeeping only.
    }
    await this.o.backend.destroy(this.handle);
    return usage;
  }
}

/** A repository-relative path, or null for one that leaves the repository. */
export function repoPath(path: string): string | null {
  const p = posix.normalize(path.replace(/^\/+/, '').replace(/^workspace\/repo\//, ''));
  if (!p || p === '.' || p.startsWith('../') || p === '..' || p.includes('\0')) return null;
  return p;
}

