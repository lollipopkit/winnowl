import { execFile } from 'node:child_process';

import type { Severity } from '@reviewbot/findings';
import { detectDependencyManifests, parseNpmAudit, parseOsvScanner, renderDependencyEvidence, type DependencyVulnerability } from './dep-audit.js';

// Runs osv-scanner over the head workspace's lockfiles; repository code is never executed.

/**
 * Hosts the dependency scanners query (osv-scanner's advisory API, npm audit's registry). Scanners
 * run in sandboxes whose egress allowlist must include them (scripts/gen-squid-conf.ts).
 */
export const SCANNER_EGRESS_HOSTS = ['api.osv.dev', 'registry.npmjs.org'] as const;

export interface OsvScanOptions {
  headDir: string;
  /** The scan is skipped when no dependency manifest changed; ignored with `scanAll`. */
  changedFiles: string[];
  /** Full-repo scan without manifest-change gating; reviews keep it false. */
  scanAll?: boolean;
  bin?: string;
  /** Default 120s; the scanner downloads the advisory DB. */
  timeoutMs?: number;
  /** Max advisories in the prompt (default 40, highest severity first); truncation is stated in the evidence. */
  maxAdvisories?: number;
  exec?: (bin: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;
  /** Confirms the scan ran even when the downstream LLM fails. */
  onScan?: (info: { manifestCount: number; vulnerabilityCount: number; mode: 'changed' | 'all' }) => void;
}

function defaultExec(bin: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        // osv-scanner exits 1 when it finds vulnerabilities: use stdout whenever it parses as JSON.
        if (stdout && stdout.trim().startsWith('{')) {
          resolve(stdout);
          return;
        }
        if (error) {
          reject(new Error(`osv-scanner 执行失败:${error.message}${stderr ? ` (${stderr.slice(0, 500)})` : ''}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export interface DependencyScanResult {
  /** Top maxAdvisories by severity; manifestPath relative to the workspace. */
  vulnerabilities: DependencyVulnerability[];
  totalCount: number;
  evidence: string;
}

/** undefined when no manifest changed or nothing was found. Callers swallow errors: this must not block a review. */
export async function scanDependencyVulnerabilities(opts: OsvScanOptions): Promise<DependencyScanResult | undefined> {
  const manifests = detectDependencyManifests(opts.changedFiles);
  if (!opts.scanAll && manifests.length === 0) return undefined;

  const exec = opts.exec ?? defaultExec;
  const bin = opts.bin ?? 'osv-scanner';
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const stdout = await exec(bin, ['scan', '--recursive', '--format', 'json', '.'], { cwd: opts.headDir, timeoutMs });

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    opts.onScan?.({ manifestCount: manifests.length, vulnerabilityCount: 0, mode: opts.scanAll ? 'all' : 'changed' });
    return undefined; // non-JSON output
  }
  const vulns: DependencyVulnerability[] = parseOsvScanner(json);

  // npm audit as a best-effort second source for npm; failures are ignored.
  if (opts.scanAll || manifests.some((m) => m.ecosystem === 'npm')) {
    try {
      const auditOut = await exec('npm', ['audit', '--json', '--package-lock-only'], { cwd: opts.headDir, timeoutMs });
      const audit = parseNpmAudit(JSON.parse(auditOut));
      // Dedupe on ecosystem:package:advisoryId.
      const seen = new Set(vulns.map((v) => `${v.ecosystem}:${v.package}:${v.advisoryId}`));
      for (const v of audit) {
        const k = `${v.ecosystem}:${v.package}:${v.advisoryId}`;
        if (!seen.has(k)) {
          seen.add(k);
          vulns.push(v);
        }
      }
    } catch {
      // best-effort
    }
  }

  // In scanAll mode manifests is always empty; log the mode so that is not misread.
  opts.onScan?.({ manifestCount: manifests.length, vulnerabilityCount: vulns.length, mode: opts.scanAll ? 'all' : 'changed' });
  if (vulns.length === 0) return undefined;

  const max = opts.maxAdvisories ?? 40;
  const ranked = [...vulns].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const shown = ranked.slice(0, max).map((v) => ({
    ...v,
    // osv may report absolute paths.
    ...(v.manifestPath ? { manifestPath: relativizeManifest(v.manifestPath, opts.headDir) } : {}),
  }));
  const evidence = renderDependencyEvidence(shown);
  return {
    vulnerabilities: shown,
    totalCount: ranked.length,
    evidence:
      ranked.length > shown.length
        ? `${evidence}\n(and ${ranked.length - shown.length} more lower-severity advisory(ies) omitted; ${ranked.length} total.)`
        : evidence,
  };
}

/** Strips the workspace prefix and a leading `./`. */
function relativizeManifest(p: string, headDir: string): string {
  const norm = p.startsWith(headDir) ? p.slice(headDir.length) : p;
  return norm.replace(/^\/+/, '').replace(/^\.\//, '');
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
