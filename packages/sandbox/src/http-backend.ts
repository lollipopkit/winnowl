import { Readable } from 'node:stream';
import { Agent, fetch, type Dispatcher, type Response } from 'undici';
import {
  AGENT_API_PREFIX,
  SSE_PING_MS,
  SseParser,
  type AgentCreateRequest,
  type AgentCreateResult,
  type AgentError,
  type AgentExecStarted,
  type AgentHealth,
  type AgentSweepRequest,
  type AgentSweepResult,
  type AgentTreeFromWorkspaceRequest,
  type AgentWorkspaceOpenRequest,
  type AgentWorkspaceOpenResult,
  type SseEvent,
} from './agent-protocol.js';
import { tarDirectory } from './exec.js';
import type {
  ArtifactContent,
  ExecRequest,
  ExecResult,
  PutFileRequest,
  SandboxBackend,
  SandboxHandle,
  SandboxResize,
  SandboxSpec,
  SandboxUsage,
} from './types.js';

export interface HttpBackendOptions {
  /** Agent origin, e.g. `https://sandbox-1.example.com`. */
  baseUrl: string;
  /** Bearer token the agent checks (its sha256 is configured on the agent). */
  token: string;
  /** Worker id; becomes the owner label of every sandbox this backend creates. */
  ownerId?: string;
  /** Silence on an SSE stream longer than this counts as a dropped connection. Default 4 pings. */
  heartbeatTimeoutMs?: number;
  /** How long past an exec's own timeout re-attaching may continue. Default 10 min. */
  reattachGraceMs?: number;
  dispatcher?: Dispatcher;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** The agent answered with an error (unknown sandbox, rejected request, failure on the VM). */
export class AgentRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRequestError';
  }
}

/** The connection broke before a terminal event; the operation may still be running on the VM. */
class StreamDroppedError extends Error {
  constructor(cause: unknown) {
    super(`agent stream dropped: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'StreamDroppedError';
  }
}

const SIMPLE_REQUEST_TIMEOUT_MS = 60_000;
/** Bound for `create` (image pull + docker create/start). */
const CREATE_TIMEOUT_MS = 15 * 60_000;
/** Bound for `copyInto`: upload plus the agent's 120 s extraction. */
const COPY_TIMEOUT_MS = 10 * 60_000;

/**
 * `SandboxBackend` over a remote `apps/sandbox-agent`. Long calls use SSE; a dropped exec stream is
 * re-attached by exec id, so a network blip costs a reconnect instead of the whole review.
 */
export class HttpSandboxBackend implements SandboxBackend {
  private readonly base: string;
  private readonly heartbeatTimeoutMs: number;
  private readonly reattachGraceMs: number;
  private readonly dispatcher: Dispatcher;
  private readonly log: NonNullable<HttpBackendOptions['log']>;

  constructor(private readonly options: HttpBackendOptions) {
    this.base = `${options.baseUrl.replace(/\/+$/, '')}${AGENT_API_PREFIX}`;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 4 * SSE_PING_MS;
    this.reattachGraceMs = options.reattachGraceMs ?? 10 * 60_000;
    // Only our own watchdog and explicit deadlines may cut a connection; undici's 300 s body
    // timeout would otherwise end every long exec stream.
    this.dispatcher = options.dispatcher ?? new Agent({ bodyTimeout: 0, headersTimeout: 0 });
    this.log = options.log ?? (() => undefined);
  }

  async health(): Promise<AgentHealth> {
    return this.json<AgentHealth>('GET', '/health', undefined, 10_000);
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const body: AgentCreateRequest = {
      spec,
      ...(this.options.ownerId ? { owner: this.options.ownerId } : {}),
    };
    // Not retried on a dropped stream: the container may exist already, and the owner label lets
    // the orphan sweep reclaim it.
    return this.sse<AgentCreateResult>('POST', '/sandboxes', body, CREATE_TIMEOUT_MS);
  }

  async exec(handle: SandboxHandle, req: ExecRequest): Promise<ExecResult> {
    const sandbox = encodeURIComponent(handle.id);
    const deadline = Date.now() + req.timeoutMs + 5_000 + this.reattachGraceMs;
    let execId: string | undefined;
    const onEvent = (e: SseEvent): void => {
      if (e.event === 'started') execId = (JSON.parse(e.data) as AgentExecStarted).execId;
    };
    for (let attempt = 0; ; attempt++) {
      try {
        return execId === undefined
          ? await this.sse<ExecResult>(
              'POST',
              `/sandboxes/${sandbox}/execs`,
              req,
              deadline - Date.now(),
              onEvent,
            )
          : await this.sse<ExecResult>(
              'GET',
              `/sandboxes/${sandbox}/execs/${encodeURIComponent(execId)}`,
              undefined,
              deadline - Date.now(),
            );
      } catch (err) {
        if (!(err instanceof StreamDroppedError)) throw err;
        // Without an exec id the command may or may not have started; running it again could
        // double side effects (LLM spend), so the job-level retry decides instead.
        if (execId === undefined) throw err;
        if (Date.now() >= deadline) throw err;
        const backoffMs = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
        this.log('sandbox exec stream dropped; re-attaching', {
          sandbox: handle.id,
          execId,
          attempt,
          backoffMs,
          err: err.message,
        });
        await sleep(backoffMs);
      }
    }
  }

  async putFile(handle: SandboxHandle, req: PutFileRequest): Promise<void> {
    await this.request(
      'PUT',
      `/sandboxes/${encodeURIComponent(handle.id)}/files?path=${encodeURIComponent(req.path)}`,
      { body: req.content, contentType: 'text/plain; charset=utf-8' },
      SIMPLE_REQUEST_TIMEOUT_MS,
    );
  }

  async getArtifact(handle: SandboxHandle, path: string): Promise<ArtifactContent> {
    return this.json<ArtifactContent>(
      'GET',
      `/sandboxes/${encodeURIComponent(handle.id)}/files?path=${encodeURIComponent(path)}`,
      undefined,
      SIMPLE_REQUEST_TIMEOUT_MS,
    );
  }

  async copyInto(
    handle: SandboxHandle,
    srcHostDir: string,
    destContainerDir: string,
  ): Promise<void> {
    const tar = tarDirectory(srcHostDir);
    try {
      await this.request(
        'PUT',
        `/sandboxes/${encodeURIComponent(handle.id)}/tree?dest=${encodeURIComponent(destContainerDir)}`,
        { body: Readable.toWeb(tar.stream) as ReadableStream, contentType: 'application/x-tar' },
        COPY_TIMEOUT_MS,
      );
    } catch (err) {
      tar.abort();
      throw err;
    }
    await tar.done;
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    try {
      await this.request(
        'DELETE',
        `/sandboxes/${encodeURIComponent(handle.id)}`,
        {},
        SIMPLE_REQUEST_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof AgentRequestError && err.status === 404) return;
      throw err;
    }
  }

  async resize(handle: SandboxHandle, req: SandboxResize): Promise<SandboxUsage> {
    return this.json<SandboxUsage>('POST', `/sandboxes/${encodeURIComponent(handle.id)}/resize`, req, SIMPLE_REQUEST_TIMEOUT_MS);
  }

  async usage(handle: SandboxHandle): Promise<SandboxUsage> {
    return this.json<SandboxUsage>('GET', `/sandboxes/${encodeURIComponent(handle.id)}/usage`, undefined, SIMPLE_REQUEST_TIMEOUT_MS);
  }

  /** Opens a workspace (clone) on the agent host; `request` is the code plane's WorkspaceRequest. */
  async openWorkspace(request: unknown): Promise<AgentWorkspaceOpenResult> {
    const body: AgentWorkspaceOpenRequest = {
      request,
      ...(this.options.ownerId ? { owner: this.options.ownerId } : {}),
    };
    // Not retried on a dropped stream: the orphan sweep removes a workspace nobody holds.
    return this.sse<AgentWorkspaceOpenResult>('POST', '/workspaces', body, CREATE_TIMEOUT_MS);
  }

  /** One code-plane request against a workspace. */
  async workspaceOp(workspaceId: string, op: unknown): Promise<unknown> {
    return this.json<unknown>('POST', `/workspaces/${encodeURIComponent(workspaceId)}/ops`, op, SIMPLE_REQUEST_TIMEOUT_MS);
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    try {
      await this.request('DELETE', `/workspaces/${encodeURIComponent(workspaceId)}`, {}, SIMPLE_REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof AgentRequestError && err.status === 404) return;
      throw err;
    }
  }

  /** Copies a workspace's head worktree into a sandbox on the same host (no network transfer). */
  async copyTreeFromWorkspace(handle: SandboxHandle, workspaceId: string, destContainerDir: string): Promise<void> {
    const body: AgentTreeFromWorkspaceRequest = { workspaceId, dest: destContainerDir };
    await this.request(
      'POST',
      `/sandboxes/${encodeURIComponent(handle.id)}/tree-from-workspace`,
      { body: JSON.stringify(body), contentType: 'application/json' },
      COPY_TIMEOUT_MS,
    );
  }

  async sweepOrphans(olderThanMs: number, liveOwners?: ReadonlySet<string>): Promise<number> {
    const body: AgentSweepRequest = {
      olderThanMs,
      ...(liveOwners ? { liveOwners: [...liveOwners] } : {}),
    };
    const r = await this.json<AgentSweepResult>('POST', '/sweep', body, SIMPLE_REQUEST_TIMEOUT_MS);
    return r.removed;
  }

  private async json<T>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const res = await this.request(
      method,
      path,
      body === undefined ? {} : { body: JSON.stringify(body), contentType: 'application/json' },
      timeoutMs,
    );
    return (await res.json()) as T;
  }

  private async request(
    method: string,
    path: string,
    payload: { body?: string | ReadableStream; contentType?: string },
    timeoutMs: number,
  ): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(payload.contentType ? { 'content-type': payload.contentType } : {}),
      },
      ...(payload.body !== undefined ? { body: payload.body } : {}),
      ...(payload.body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: this.dispatcher,
    });
    if (!res.ok) throw await toAgentError(res);
    return res;
  }

  /**
   * One SSE call: resolves with the `result` event, throws AgentRequestError on an `error` event
   * or non-2xx answer, and StreamDroppedError when the connection ends or goes silent first.
   */
  private async sse<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
    onEvent?: (e: SseEvent) => void,
  ): Promise<T> {
    const ac = new AbortController();
    const overall = setTimeout(
      () => ac.abort(new Error('deadline exceeded')),
      Math.max(0, timeoutMs),
    );
    let watchdog: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => ac.abort(new Error('heartbeat timeout')),
        this.heartbeatTimeoutMs,
      );
    };
    try {
      let res: Response;
      try {
        arm();
        res = await fetch(`${this.base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            accept: 'text/event-stream',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: ac.signal,
          dispatcher: this.dispatcher,
        });
      } catch (err) {
        throw new StreamDroppedError(err);
      }
      if (!res.ok || !res.body) throw await toAgentError(res);
      const parser = new SseParser();
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          arm();
          for (const e of parser.push(decoder.decode(chunk as Uint8Array, { stream: true }))) {
            if (e.event === 'result') return JSON.parse(e.data) as T;
            if (e.event === 'error') {
              const err = JSON.parse(e.data) as AgentError;
              throw new AgentRequestError(err.status, err.message);
            }
            onEvent?.(e);
          }
        }
      } catch (err) {
        if (err instanceof AgentRequestError) throw err;
        throw new StreamDroppedError(err);
      }
      throw new StreamDroppedError(new Error('stream ended without a result'));
    } finally {
      clearTimeout(overall);
      clearTimeout(watchdog);
      ac.abort();
    }
  }
}

async function toAgentError(res: Response): Promise<AgentRequestError> {
  const text = await res.text().catch(() => '');
  let message = text.slice(0, 500);
  try {
    message = (JSON.parse(text) as AgentError).message ?? message;
  } catch {
    // Non-JSON body (e.g. the exe.dev proxy's HTML 503 page); keep the raw prefix.
  }
  return new AgentRequestError(res.status, `agent ${res.status}: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
