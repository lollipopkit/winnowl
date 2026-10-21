import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  openLocalWorkspace,
  type CodePlaneRequest,
  type LocalWorkspace,
  type WorkspaceInfo,
  type WorkspaceRequest,
} from '@reviewbot/review-runtime';

/** Per-job clone + head worktree on this host; isolated per directory and deleted when the job ends. */
export interface WorkspaceStore {
  open(request: WorkspaceRequest, owner: string | undefined): Promise<{ id: string; info: WorkspaceInfo }>;
  op(id: string, req: CodePlaneRequest): Promise<unknown>;
  /** Head worktree of a workspace (copied into sandboxes on this host), or undefined. */
  headDir(id: string): string | undefined;
  close(id: string): Promise<void>;
  sweep(liveOwners: ReadonlySet<string> | undefined): Promise<number>;
  count(): number;
}

export const WORKSPACE_ID = /^ws-[0-9a-f-]{36}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REF = /^refs\/[A-Za-z0-9._/-]+$/;
const BRANCH = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/** The clone source must be https: `file://` or a bare path would clone this host's own files. */
export function parseWorkspaceRequest(value: unknown): WorkspaceRequest | string {
  if (!value || typeof value !== 'object') return 'request required';
  const r = value as Record<string, unknown>;
  if (typeof r.cloneUrl !== 'string' || !r.cloneUrl.startsWith('https://')) return 'cloneUrl must be an https URL';
  if (r.headSha !== undefined && (typeof r.headSha !== 'string' || !SHA.test(r.headSha))) return 'invalid headSha';
  if (r.baseSha !== undefined && (typeof r.baseSha !== 'string' || !SHA.test(r.baseSha))) return 'invalid baseSha';
  if (r.headRef !== undefined && (typeof r.headRef !== 'string' || !REF.test(r.headRef) || r.headRef.includes('..'))) return 'invalid headRef';
  if (
    r.stackRootBranch !== undefined &&
    (typeof r.stackRootBranch !== 'string' || !BRANCH.test(r.stackRootBranch) || r.stackRootBranch.includes('..'))
  )
    return 'invalid stackRootBranch';
  if (r.depth !== undefined && (!Number.isInteger(r.depth) || (r.depth as number) < 1 || (r.depth as number) > 1000)) return 'invalid depth';
  return {
    cloneUrl: r.cloneUrl,
    ...(r.headSha !== undefined ? { headSha: r.headSha as string } : {}),
    ...(r.baseSha !== undefined ? { baseSha: r.baseSha as string } : {}),
    ...(r.headRef !== undefined ? { headRef: r.headRef as string } : {}),
    ...(r.stackRootBranch !== undefined ? { stackRootBranch: r.stackRootBranch as string } : {}),
    ...(r.depth !== undefined ? { depth: r.depth as number } : {}),
  };
}

interface Entry {
  ws: LocalWorkspace;
  owner: string | undefined;
  openedAt: number;
}

export class LocalWorkspaceStore implements WorkspaceStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly root: string,
    /** Hard age cap; review jobs are bounded well below this. */
    private readonly maxAgeMs = 3 * 60 * 60_000,
  ) {}

  /** Clears what a previous process left behind: its control plane's jobs are gone with it. */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root).catch(() => [])) {
      await rm(join(this.root, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async open(request: WorkspaceRequest, owner: string | undefined): Promise<{ id: string; info: WorkspaceInfo }> {
    const id = `ws-${randomUUID()}`;
    const ws = await openLocalWorkspace(request, join(this.root, id));
    this.entries.set(id, { ws, owner, openedAt: Date.now() });
    return { id, info: ws.info };
  }

  async op(id: string, req: CodePlaneRequest): Promise<unknown> {
    const e = this.entries.get(id);
    if (!e) throw new UnknownWorkspaceError(id);
    return e.ws.handle(req);
  }

  headDir(id: string): string | undefined {
    return this.entries.get(id)?.ws.headDir;
  }

  async close(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    await e.ws.dispose();
    await rm(join(this.root, id), { recursive: true, force: true }).catch(() => undefined);
  }

  async sweep(liveOwners: ReadonlySet<string> | undefined): Promise<number> {
    const cutoff = Date.now() - this.maxAgeMs;
    let removed = 0;
    for (const [id, e] of [...this.entries]) {
      const ownerGone = e.owner !== undefined && liveOwners !== undefined && !liveOwners.has(e.owner);
      if (ownerGone || e.openedAt < cutoff) {
        await this.close(id);
        removed += 1;
      }
    }
    return removed;
  }

  count(): number {
    return this.entries.size;
  }
}

export class UnknownWorkspaceError extends Error {
  constructor(id: string) {
    super(`unknown workspace: ${id}`);
    this.name = 'UnknownWorkspaceError';
  }
}
