import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { CodePlane } from '@reviewbot/review-runtime';
import { SANDBOX_PRIORITY, type SandboxBackend, type SandboxResources } from '@reviewbot/sandbox';
import { SCANNER_EGRESS_HOSTS } from '@reviewbot/security-agent';
import { readOnlyTree, workspaceMount, workspacePlacement } from './code-plane.js';

/**
 * Runs deterministic scanners over a workspace's head tree where the tree is: on a sandbox host, in a
 * throwaway sandbox there (scanners parse repo files, so never in the agent process or control plane);
 * for a local workspace, as local processes. Scanners exit non-zero when they find something.
 */
export type ScanExec = (bin: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;

export interface WorkspaceScanDeps {
  sandbox: SandboxBackend;
  /** Sandbox image (carries the scanner binaries and the baked semgrep rules). */
  image: string;
  resources: SandboxResources;
  /** Egress proxy URL as seen from inside a sandbox (`http://egress-proxy:3128`). */
  egressProxyUrl?: string;
}


const TREE = '/workspace/tree';
const MAX_OUTPUT = 64 * 1024 * 1024;

export async function withWorkspaceScanner<T>(
  deps: WorkspaceScanDeps,
  plane: CodePlane,
  fn: (scan: { exec: ScanExec; dir: string; readFile: (path: string) => Promise<string> }) => Promise<T>,
): Promise<T> {
  const location = plane.location;
  if (location.kind === 'local') {
    return fn({ exec: localExec, dir: location.headDir, readFile: (p) => readFile(p, 'utf8') });
  }
  const handle = await deps.sandbox.create({
    image: deps.image,
    network: { mode: 'allowlist', hosts: [...SCANNER_EGRESS_HOSTS] },
    resources: { ...deps.resources, workspace: 'disk' },
    ...workspacePlacement(plane),
    ...workspaceMount(plane, TREE),
    priority: SANDBOX_PRIORITY.scan,
    maxLifetimeSeconds: 20 * 60,
  });
  try {
    // Scanners only read: the clone is mounted read-only (copied and sealed for a local workspace).
    await readOnlyTree(deps.sandbox, handle, plane, TREE);
    // The rootfs is read-only: scanners keep their caches and settings under HOME=/tmp.
    const env: Record<string, string> = {
      HOME: '/tmp',
      XDG_CACHE_HOME: '/tmp/.cache',
      ...(deps.egressProxyUrl
        ? { HTTPS_PROXY: deps.egressProxyUrl, HTTP_PROXY: deps.egressProxyUrl, https_proxy: deps.egressProxyUrl, http_proxy: deps.egressProxyUrl }
        : {}),
    };
    const exec: ScanExec = async (bin, args, opts) => {
      const r = await deps.sandbox.exec(handle, {
        argv: [bin, ...args],
        cwd: opts.cwd,
        env,
        purpose: 'static-analysis',
        timeoutMs: opts.timeoutMs,
        maxOutputBytes: MAX_OUTPUT,
      });
      const head = r.stdout.trimStart()[0];
      if (head === '{' || head === '[') return r.stdout;
      if (r.exitCode !== 0 || r.timedOut) {
        throw new Error(`${bin} failed in the scan sandbox (exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}): ${r.stderr.slice(-300)}`);
      }
      return r.stdout;
    };
    const readArtifact = async (path: string): Promise<string> => (await deps.sandbox.getArtifact(handle, path)).content;
    return await fn({ exec, dir: TREE, readFile: readArtifact });
  } finally {
    await deps.sandbox.destroy(handle).catch(() => undefined);
  }
}

function localExec(bin: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout, stderr) => {
      const head = stdout.trimStart()[0];
      if (head === '{' || head === '[') return resolve(stdout);
      if (error) return reject(new Error(`${bin} failed: ${error.message}${stderr ? ` (${stderr.slice(0, 300)})` : ''}`));
      resolve(stdout);
    });
  });
}
