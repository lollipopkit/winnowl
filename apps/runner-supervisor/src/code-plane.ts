import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authedCloneUrl,
  codePlaneClient,
  openLocalCodePlane,
  WorkspaceHeadMissingError,
  type CodePlane,
  type CodePlaneRequest,
  type WorkspaceInfo,
  type WorkspaceRequest,
} from '@reviewbot/review-runtime';
import { AgentPoolSandboxBackend, AgentRequestError, type SandboxBackend, type SandboxHandle } from '@reviewbot/sandbox';
import { JobExecutionError } from './supervisor.js';

/**
 * Opens a job's workspace: on a sandbox host when the sandbox
 * backend is the agent pool (the control plane then never holds a clone), in this process
 * otherwise (single host, tests). Callers get the same `CodePlane` either way.
 */
export interface WorkspaceTarget {
  /** Repository clone URL without credentials. */
  cloneUrl: string;
  /** The read-only, single-repository token the clone uses (see `getInstallationToken` scope). */
  token: string;
  headSha?: string;
  baseSha?: string;
  headRef?: string;
  stackRootBranch?: string;
  depth?: number;
}

export function createCodePlaneOpener(input: {
  sandbox: SandboxBackend;
  /** Local workspaces' root (single-host mode). */
  localRoot?: string;
  /** Told about submodules whose files are missing (private, another host, failed fetch). */
  onSkippedSubmodules?: (target: WorkspaceTarget, skipped: NonNullable<WorkspaceInfo['submodules']>) => void;
}): (target: WorkspaceTarget) => Promise<CodePlane> {
  let localRoot: Promise<string> | undefined;
  const report = (target: WorkspaceTarget, plane: CodePlane): CodePlane => {
    const skipped = plane.info.submodules?.filter((s) => s.status === 'skipped') ?? [];
    if (skipped.length > 0) input.onSkippedSubmodules?.(target, skipped);
    return plane;
  };
  return async (target) => {
    const request: WorkspaceRequest = {
      cloneUrl: authedCloneUrl(target.cloneUrl, target.token),
      ...(target.headSha !== undefined ? { headSha: target.headSha } : {}),
      ...(target.baseSha !== undefined ? { baseSha: target.baseSha } : {}),
      ...(target.headRef !== undefined ? { headRef: target.headRef } : {}),
      ...(target.stackRootBranch !== undefined ? { stackRootBranch: target.stackRootBranch } : {}),
      ...(target.depth !== undefined ? { depth: target.depth } : {}),
    };
    if (input.sandbox instanceof AgentPoolSandboxBackend) {
      let ws;
      try {
        ws = await input.sandbox.openWorkspace(request);
      } catch (err) {
        throw asJobError(err);
      }
      const opened = ws;
      return report(target, {
        info: opened.info as WorkspaceInfo,
        client: codePlaneClient((req: CodePlaneRequest) => opened.op(req)),
        location: { kind: 'agent', host: opened.host, workspaceId: opened.id },
        dispose: () => opened.close().catch(() => undefined),
      });
    }
    localRoot ??= input.localRoot ? Promise.resolve(input.localRoot) : mkdtemp(join(tmpdir(), 'winnowl-ws-'));
    try {
      return report(target, await openLocalCodePlane(request, await localRoot));
    } catch (err) {
      throw asJobError(err);
    }
  };
}

/**
 * The head is not in the repository (closed fork PR, force push): retrying fetches the same
 * missing ref, and the cause is the repository, not our code.
 */
function asJobError(err: unknown): unknown {
  const missing =
    err instanceof WorkspaceHeadMissingError || (err instanceof AgentRequestError && err.status === 422);
  return missing ? new JobExecutionError((err as Error).message, 'repository_invalid', false) : err;
}

/** The host a sandbox must run on to reach this workspace (undefined = anywhere). */
export function workspacePlacement(plane: CodePlane): { placement?: string } {
  return plane.location.kind === 'agent' ? { placement: plane.location.host } : {};
}

/**
 * For sandboxes that only read the code: on a sandbox host the workspace's head tree is mounted
 * read-only at `dest` when the sandbox is created (no copy, and the sandbox cannot change it). A
 * local workspace has no such mount; `readOnlyTree` then copies it in and makes it read-only.
 */
export function workspaceMount(plane: CodePlane, dest: string): { mountWorkspace?: { workspaceId: string; dest: string } } {
  return plane.location.kind === 'agent' ? { mountWorkspace: { workspaceId: plane.location.workspaceId, dest } } : {};
}

/**
 * The head tree at `dest` in a sandbox created with `workspaceMount(plane, dest)`, read-only: already
 * there on a sandbox host; otherwise copied in and sealed.
 */
export async function readOnlyTree(sandbox: SandboxBackend, handle: SandboxHandle, plane: CodePlane, dest: string): Promise<void> {
  if (plane.location.kind === 'agent') return;
  await copyWorkspaceInto(sandbox, handle, plane, dest);
  const sealed = await sandbox.exec(handle, {
    argv: ['chmod', '-R', 'a-w', dest],
    purpose: 'bootstrap',
    timeoutMs: 30_000,
    maxOutputBytes: 32_000,
  });
  if (sealed.exitCode !== 0) throw new Error(`could not make the copied tree read-only: ${sealed.stderr.slice(-500)}`);
}

/** Can this backend put the workspace's head tree into one of its sandboxes? */
export function canReceiveWorkspace(sandbox: SandboxBackend, plane: CodePlane): boolean {
  return plane.location.kind === 'agent'
    ? typeof sandbox.copyFromWorkspace === 'function'
    : typeof sandbox.copyInto === 'function';
}

/**
 * Copies the workspace's head tree into a sandbox created with `workspacePlacement(plane)`: on a
 * sandbox host it never crosses the network; a local workspace is copied in from disk.
 */
export function copyWorkspaceInto(
  sandbox: SandboxBackend,
  handle: SandboxHandle,
  plane: CodePlane,
  dest: string,
): Promise<void> {
  const location = plane.location;
  if (location.kind === 'agent') {
    if (!sandbox.copyFromWorkspace) return Promise.reject(new Error('sandbox backend cannot reach workspaces on sandbox hosts'));
    return sandbox.copyFromWorkspace(handle, { host: location.host, workspaceId: location.workspaceId }, dest);
  }
  if (!sandbox.copyInto) return Promise.reject(new Error('sandbox backend cannot copy a local tree in'));
  return sandbox.copyInto(handle, location.headDir, dest);
}
