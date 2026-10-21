import type { ExecRequest, SandboxSpec } from './types.js';

/**
 * Wire protocol between `HttpSandboxBackend` (control plane) and `apps/sandbox-agent`.
 *
 * Calls that can run long answer with Server-Sent Events: headers immediately, a `: ping` comment
 * every {@link SSE_PING_MS}, then one terminal `result` or `error` event. The exe.dev HTTPS proxy
 * answers 503 when response headers take over 300 s, but keeps streaming responses alive.
 */
export const AGENT_API_PREFIX = '/v1';
export const SSE_PING_MS = 15_000;

export interface AgentCreateRequest {
  spec: SandboxSpec;
  /** Worker id of the control-plane process; becomes the sandbox owner label (orphan sweep). */
  owner?: string;
}

export interface AgentCreateResult {
  id: string;
  containerId: string;
}

export type AgentExecRequest = ExecRequest;

/** First event of an exec stream: the id to re-attach with after a dropped connection. */
export interface AgentExecStarted {
  execId: string;
}

/** Workspace on the agent host; shapes are the code plane's WorkspaceRequest / WorkspaceInfo, only carried here. */
export interface AgentWorkspaceOpenRequest {
  request: unknown;
  owner?: string;
}

export interface AgentWorkspaceOpenResult {
  id: string;
  info: unknown;
}

/** Copy a workspace's head worktree into a sandbox on the same host. */
export interface AgentTreeFromWorkspaceRequest {
  workspaceId: string;
  dest: string;
}

export interface AgentSweepRequest {
  olderThanMs: number;
  liveOwners?: string[];
}

export interface AgentSweepResult {
  removed: number;
}

export interface AgentHealth {
  version: string;
  sandboxes: number;
  /** Most sandboxes this agent runs at once (absent = no cap). */
  maxSandboxes?: number;
  /** Shutting down: refuses new sandboxes while the running ones finish. */
  draining?: boolean;
  /** Open workspaces (absent on agents without workspace support). */
  workspaces?: number;
  /** Memory limits of the running sandboxes, summed (MiB), and the host's budget (absent = none). */
  memoryMb?: number;
  maxMemoryMb?: number;
  /** Free disk-quota slots (absent = the host has none; disk sandboxes then need none). */
  scratchFree?: number;
  /** Disk (MiB) a new or growing slot can get now (with `scratchFree`). */
  scratchFreeMb?: number;
}

export interface AgentError {
  message: string;
  /** HTTP-like status: 404 = unknown sandbox/exec, 400 = rejected request, 500 = failure. */
  status: number;
}

/** One parsed SSE event. Comments (`: ping`) are surfaced as `{ event: 'comment' }`. */
export interface SseEvent {
  event: string;
  data: string;
}

export function formatSseEvent(event: string, data: unknown): string {
  const json = JSON.stringify(data);
  return `event: ${event}\ndata: ${json}\n\n`;
}

/**
 * Incremental SSE parser (only the subset the agent emits: `event:`, single `data:` line, comments).
 * Feed decoded text chunks; complete events are returned, partial ones are kept for the next chunk.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) {
          out.push({ event: 'comment', data: line.slice(1).trim() });
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).trimStart());
        }
      }
      if (data.length > 0) out.push({ event, data: data.join('\n') });
    }
    return out;
  }
}
