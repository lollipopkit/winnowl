import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Severity } from '@reviewbot/findings';

/**
 * Deterministic static scanners (semgrep, gitleaks) whose hits are evidence for the agent, not
 * verdicts. Neither runs repository code. Secrets are never echoed: only rule/file/line/fingerprint
 * are kept from gitleaks output, so no plaintext reaches prompts, audit or email.
 */

export type StaticScanner = 'semgrep' | 'gitleaks';

export interface StaticFinding {
  scanner: StaticScanner;
  /** semgrep `check_id` / gitleaks `RuleID`. */
  ruleId: string;
  severity: Severity;
  path: string;
  line?: number;
  /** Never contains matched secret content. */
  message: string;
}

function semgrepSeverity(raw: unknown): Severity {
  switch (String(raw).toUpperCase()) {
    case 'ERROR':
      return 'high';
    case 'WARNING':
      return 'medium';
    default:
      return 'low';
  }
}

/** Skips unknown shapes rather than throwing. */
export function parseSemgrep(json: unknown, stripPrefix?: string): StaticFinding[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const out: StaticFinding[] = [];
  for (const r of results) {
    const row = r as {
      check_id?: unknown;
      path?: unknown;
      start?: { line?: unknown };
      extra?: { message?: unknown; severity?: unknown };
    };
    if (typeof row.check_id !== 'string' || typeof row.path !== 'string') continue;
    const line = typeof row.start?.line === 'number' ? row.start.line : undefined;
    out.push({
      scanner: 'semgrep',
      ruleId: row.check_id,
      severity: semgrepSeverity(row.extra?.severity),
      path: relativize(row.path, stripPrefix),
      ...(line !== undefined ? { line } : {}),
      message: typeof row.extra?.message === 'string' ? row.extra.message.slice(0, 500) : row.check_id,
    });
  }
  return out;
}

/** Metadata only: `Secret`/`Match`/`Line` are never read, not even truncated. */
export function parseGitleaks(json: unknown, stripPrefix?: string): StaticFinding[] {
  if (!Array.isArray(json)) return [];
  const out: StaticFinding[] = [];
  for (const r of json) {
    const row = r as { RuleID?: unknown; Description?: unknown; File?: unknown; StartLine?: unknown };
    if (typeof row.File !== 'string') continue;
    const ruleId = typeof row.RuleID === 'string' ? row.RuleID : 'gitleaks-rule';
    const line = typeof row.StartLine === 'number' ? row.StartLine : undefined;
    out.push({
      scanner: 'gitleaks',
      ruleId,
      // Leaked credentials are always critical; the agent verifies validity.
      severity: 'critical',
      path: relativize(row.File, stripPrefix),
      ...(line !== undefined ? { line } : {}),
      message: typeof row.Description === 'string' ? row.Description.slice(0, 200) : `possible secret (${ruleId})`,
    });
  }
  return out;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** Marked UNTRUSTED: scanner output, not instructions; the agent must verify each hit in code. */
export function renderStaticEvidence(findings: StaticFinding[], totalCount = findings.length): string {
  if (findings.length === 0) return '';
  const lines = findings.map((f) => {
    const at = f.line !== undefined ? `${f.path}:${f.line}` : f.path;
    return `- [${f.scanner}][${f.severity}] ${at} — ${f.ruleId}: ${f.message}`;
  });
  const omitted = totalCount > findings.length ? `\n(and ${totalCount - findings.length} more lower-severity hit(s) omitted; ${totalCount} total.)` : '';
  return [
    'Deterministic scanner hits (evidence only — verify each by reading the code before reporting; scanners over-report):',
    ...lines,
    'Secret matches are redacted by design: only rule/location is available, never the matched value.',
  ].join('\n') + omitted;
}

export interface StaticScanOptions {
  dir: string;
  /**
   * Default `p/security-audit`. Not `p/ci`: it is tuned for low noise and misses findings such as
   * `eval(user_input)`. Not `auto`: it profiles the repo over the network and is nondeterministic.
   */
  semgrepConfig?: string;
  semgrepBin?: string;
  gitleaksBin?: string;
  /** Per scanner, default 180s (semgrep fetches rules on first run). */
  timeoutMs?: number;
  /** Max hits in the prompt (default 40, highest severity first). */
  maxFindings?: number;
  exec?: (bin: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;
  /**
   * gitleaks cannot write its JSON report to stdout (`--report-path /dev/stdout` fails in containers
   * without that device), so it writes a temp file that is read back.
   */
  readReport?: (path: string) => Promise<string>;
  reportPath?: string;
  /** Confirms the scan ran even when the downstream LLM fails. */
  onScan?: (info: { scanner: StaticScanner; count: number; failed?: string }) => void;
}

export interface StaticScanResult {
  findings: StaticFinding[];
  totalCount: number;
  evidence: string;
}

function defaultExec(bin: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        // Both scanners exit 1 when they find something: use stdout whenever it parses as JSON.
        const head = stdout.trimStart()[0];
        if (head === '{' || head === '[') {
          resolve(stdout);
          return;
        }
        if (error) {
          reject(new Error(`${bin} 执行失败:${error.message}${stderr ? ` (${stderr.slice(0, 300)})` : ''}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Strips the workspace prefix and a leading `./`. */
function relativize(p: string, prefix?: string): string {
  const norm = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
  return norm.replace(/^\/+/, '').replace(/^\.\//, '');
}

/** Each scanner is best-effort: a failure is reported via `onScan.failed` and never fails the job. */
export async function scanStaticRisks(opts: StaticScanOptions): Promise<StaticScanResult | undefined> {
  const exec = opts.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const all: StaticFinding[] = [];

  try {
    const stdout = await exec(
      opts.semgrepBin ?? 'semgrep',
      // --metrics=off: no telemetry from scans of customer code (and no egress it would need).
      ['--json', '--quiet', '--metrics=off', '--config', opts.semgrepConfig ?? 'p/security-audit', '.'],
      { cwd: opts.dir, timeoutMs },
    );
    const hits = parseSemgrep(JSON.parse(stdout), opts.dir);
    all.push(...hits);
    opts.onScan?.({ scanner: 'semgrep', count: hits.length });
  } catch (error) {
    opts.onScan?.({ scanner: 'semgrep', count: 0, failed: (error as Error).message });
  }

  // `--no-git`: scan the working tree, not history (expensive and noisy).
  const reportPath = opts.reportPath ?? join(tmpdir(), `winnowl-gitleaks-${process.pid}-${Math.floor(Date.now() % 1e9)}.json`);
  try {
    await exec(
      opts.gitleaksBin ?? 'gitleaks',
      ['detect', '--no-git', '--redact', '--report-format', 'json', '--report-path', reportPath, '--exit-code', '0'],
      { cwd: opts.dir, timeoutMs },
    );
    const report = await (opts.readReport ?? ((p: string) => readFile(p, 'utf8')))(reportPath);
    // No hits: gitleaks writes `[]` or an empty file.
    const hits = report.trim() ? parseGitleaks(JSON.parse(report), opts.dir) : [];
    all.push(...hits);
    opts.onScan?.({ scanner: 'gitleaks', count: hits.length });
  } catch (error) {
    opts.onScan?.({ scanner: 'gitleaks', count: 0, failed: (error as Error).message });
  } finally {
    if (!opts.reportPath) await unlink(reportPath).catch(() => undefined);
  }

  if (all.length === 0) return undefined;
  const max = opts.maxFindings ?? 40;
  const ranked = [...all].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const shown = ranked.slice(0, max);
  return { findings: shown, totalCount: ranked.length, evidence: renderStaticEvidence(shown, ranked.length) };
}
