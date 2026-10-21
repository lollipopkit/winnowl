import { execFile } from 'node:child_process';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { CanonicalDiff } from '@reviewbot/canonical-diff';

const execFileAsync = promisify(execFile);

/** Probed once per process; falls back to a JS walk when rg is unavailable. */
let rgAvailable: Promise<boolean> | null = null;
function checkRipgrep(): Promise<boolean> {
  rgAvailable ??= execFileAsync('rg', ['--version']).then(
    () => true,
    () => false,
  );
  return rgAvailable;
}

export interface ChangedFileEntry {
  path: string;
  status: string;
  /** Renamed or copied with identical content: there is nothing in it to review. */
  pureMove?: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export function changedFilesFromDiff(diff: CanonicalDiff): ChangedFileEntry[] {
  return diff.files.map((f) => ({
    path: f.newPath ?? f.oldPath ?? '',
    status: f.status,
    ...((f.status === 'renamed' || f.status === 'copied') && f.hunks.length === 0 ? { pureMove: true } : {}),
  }));
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build']);

/**
 * Workspace snapshot source provider (structurally an agent-pi SourceProvider). Search uses ripgrep
 * and falls back to a JS walk; both are case-insensitive fixed-string matches.
 */
/** The only shape `find_definition` / `find_references` accept. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** Wider than `searchCode` so heavily referenced symbols still show most hits. */
const SYMBOL_MAX_HITS = 200;

export class WorkspaceSourceProvider {
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly changed: ChangedFileEntry[],
    private readonly maxSearchHits = 50,
    private readonly useRipgrep = true,
  ) {
    this.root = resolve(rootDir);
  }

  async listChangedFiles(): Promise<ChangedFileEntry[]> {
    return this.changed;
  }

  private async safePath(path: string): Promise<string | null> {
    const full = resolve(join(this.root, path));
    if (full !== this.root && !full.startsWith(this.root + sep)) return null;
    try {
      const [root, target] = await Promise.all([realpath(this.root), realpath(full)]);
      return target === root || target.startsWith(root + sep) ? target : null;
    } catch {
      return null;
    }
  }

  async readFile(path: string): Promise<string | null> {
    const full = await this.safePath(path);
    if (!full) return null;
    try {
      return await readFile(full, 'utf8');
    } catch {
      return null;
    }
  }

  async searchCode(query: string): Promise<SearchHit[]> {
    if (this.useRipgrep && (await checkRipgrep())) {
      const hits = await this.ripgrep(['--fixed-strings', '--ignore-case'], query, this.maxSearchHits);
      if (hits !== null) return hits;
    }
    const needle = query.toLowerCase();
    return this.walk((line) => line.toLowerCase().includes(needle), this.maxSearchHits);
  }

  /** Whole-word, case-sensitive identifier search; non-identifiers return nothing. */
  async searchSymbol(symbol: string): Promise<SearchHit[]> {
    if (!IDENTIFIER.test(symbol)) return [];
    if (this.useRipgrep && (await checkRipgrep())) {
      const hits = await this.ripgrep(['--fixed-strings', '--word-regexp', '--case-sensitive'], symbol, SYMBOL_MAX_HITS);
      if (hits !== null) return hits;
    }
    const word = new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, '\\$')}(?![\\w$])`);
    return this.walk((line) => word.test(line), SYMBOL_MAX_HITS);
  }

  /** Returns null when rg fails (not on "no match") so the caller falls back to the walk. */
  private async ripgrep(flags: string[], query: string, maxHits: number): Promise<SearchHit[] | null> {
    const args = [
      ...flags,
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--max-columns',
      '500',
      '--max-columns-preview',
      ...[...SKIP_DIRS].flatMap((d) => ['-g', `!${d}`]),
      '--',
      query,
      '.',
    ];
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('rg', args, {
        cwd: this.root,
        maxBuffer: 4 * 1024 * 1024,
      }));
    } catch (err) {
      // rg exit 1 = no match; 2 = error.
      const e = err as { code?: number; stdout?: string };
      if (e.code === 1) return [];
      return null;
    }
    const hits: SearchHit[] = [];
    for (const line of stdout.split('\n')) {
      if (hits.length >= maxHits) break;
      // path:line:text — text may contain colons, so split only twice.
      const m = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      hits.push({ path: m[1]!.replace(/^\.\//, ''), line: Number(m[2]), text: m[3]!.trim() });
    }
    return hits;
  }

  private async walk(matches: (line: string) => boolean, maxHits: number): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    const visit = async (dir: string): Promise<void> => {
      if (hits.length >= maxHits) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hits.length >= maxHits) return;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          await visit(join(dir, entry.name));
        } else if (entry.isFile()) {
          const full = join(dir, entry.name);
          let content: string;
          try {
            content = await readFile(full, 'utf8');
          } catch {
            continue;
          }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            if (matches(lines[i]!)) {
              hits.push({ path: relative(this.root, full), line: i + 1, text: lines[i]!.trim() });
              if (hits.length >= maxHits) break;
            }
          }
        }
      }
    };
    await visit(this.root);
    return hits;
  }
}
