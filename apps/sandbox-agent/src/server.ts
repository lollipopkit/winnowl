import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  AGENT_API_PREFIX,
  SSE_PING_MS,
  formatSseEvent,
  tarDirectory,
  type AgentCreateRequest,
  type AgentError,
  type AgentHealth,
  type AgentSweepRequest,
  type AgentTreeFromWorkspaceRequest,
  type AgentWorkspaceOpenRequest,
  type ExecRequest,
  type ExecResult,
  type SandboxResize,
} from '@reviewbot/sandbox';
import type { CodePlaneRequest } from '@reviewbot/review-runtime';
import type { AgentRuntime } from './runtime.js';
import { parseWorkspaceRequest, UnknownWorkspaceError, WORKSPACE_ID, type WorkspaceStore } from './workspaces.js';

export interface AgentOptions {
  runtime: AgentRuntime;
  /** Hex sha256 of the bearer token the control plane presents. */
  tokenSha256: string;
  allowedImages: ReadonlySet<string>;
  version: string;
  /** Most sandboxes at once; a create beyond it is answered 503 so the caller tries another host. */
  maxSandboxes?: number;
  /** Sum of sandbox memory limits (MiB) incl. the one being created; over it a create gets 503. */
  maxMemoryMb?: number;
  /** True once shutdown began: new sandboxes are refused (503), running ones carry on. */
  draining?: () => boolean;
  /** Hex sha256 of the `GET /metrics` scrape token; without it the endpoint does not exist. */
  metricsTokenSha256?: string;
  workspaces?: WorkspaceStore;
  maxWorkspaces?: number;
  /** Host path of the workspace root (the agent runs in a container); absent = mounts are refused. */
  workspaceHostRoot?: { container: string; host: string };
  quiet?: boolean;
  /** How long a finished exec result stays available for re-attach. */
  execRetentionMs?: number;
  pingMs?: number;
}

const METRICS_PATH = '/metrics';

/** Container names minted by `DockerSandboxBackend` (`rvb-<uuidv7>`); anything else is refused. */
const SANDBOX_ID = /^rvb-[0-9a-f-]{36}$/;
/** Workspace and spec files reach several MB (the spec carries the diff). */
const FILE_BODY_LIMIT = 64 * 1024 * 1024;

interface ExecEntry {
  sandboxId: string;
  done: Promise<ExecResult>;
  finishedAt?: number;
}

/** Wire format: `packages/sandbox/src/agent-protocol.ts`; client: `HttpSandboxBackend`. */
export async function buildAgent(options: AgentOptions): Promise<FastifyInstance> {
  const { runtime } = options;
  const pingMs = options.pingMs ?? SSE_PING_MS;
  const retentionMs = options.execRetentionMs ?? 15 * 60_000;
  const expected = Buffer.from(options.tokenSha256, 'hex');
  if (expected.length !== 32) throw new Error('tokenSha256 must be a hex sha256 digest');

  const app = Fastify({
    logger: options.quiet ? { level: 'silent' } : { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 1024 * 1024,
  });

  // Raw tar stream for copyInto: handed to `docker exec -i ... tar -x` without buffering.
  app.addContentTypeParser('application/x-tar', (_req, payload, done) => done(null, payload));

  const metricsExpected = options.metricsTokenSha256 ? Buffer.from(options.metricsTokenSha256, 'hex') : undefined;
  if (metricsExpected && metricsExpected.length !== 32) throw new Error('metricsTokenSha256 must be a hex sha256 digest');

  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const presented = createHash('sha256').update(token).digest();
    // /metrics takes the scrape token only; the control-plane token never reaches Prometheus.
    const want = req.url === METRICS_PATH ? metricsExpected : expected;
    if (!token || !want || !timingSafeEqual(presented, want)) {
      return reply.code(401).send(agentError(401, 'unauthorized'));
    }
  });

  const failures = { sandbox_create: 0, workspace_open: 0 };

  const execs = new Map<string, ExecEntry>();
  const gc = setInterval(() => {
    const cutoff = Date.now() - retentionMs;
    for (const [id, e] of execs)
      if (e.finishedAt !== undefined && e.finishedAt < cutoff) execs.delete(id);
  }, 60_000);
  gc.unref();
  app.addHook('onClose', async () => clearInterval(gc));

  const sandboxId = (params: unknown): string | undefined => {
    const id = (params as { id?: string }).id;
    return id && SANDBOX_ID.test(id) ? id : undefined;
  };

  app.get(`${AGENT_API_PREFIX}/health`, async (): Promise<AgentHealth> => ({
    version: options.version,
    sandboxes: await runtime.count(),
    ...(options.maxSandboxes ? { maxSandboxes: options.maxSandboxes } : {}),
    ...(options.draining?.() ? { draining: true } : {}),
    ...(options.workspaces ? { workspaces: options.workspaces.count() } : {}),
    ...(options.maxMemoryMb
      ? { memoryMb: await runtime.memoryMb().catch(() => options.maxMemoryMb!), maxMemoryMb: options.maxMemoryMb }
      : {}),
    ...scratchField(runtime.scratchFree?.()),
    // Unanswered quota service: nothing can be granted (0), not "no slots" (absent).
    ...(runtime.scratchStatus ? mbField((await runtime.scratchStatus().catch(() => ({ freeMb: 0 })))?.freeMb) : {}),
  }));

  // Creates and grows still in flight: not yet visible to `runtime.count()` / `memoryMb()` (docker).
  let creating = 0;
  let creatingMemoryMb = 0;

  /** Why a create of `memoryMb` does not fit right now (the in-flight one already counted). */
  const refusal = async (memoryMb: number, disk: boolean): Promise<string | undefined> => {
    if (disk && runtime.scratchFree?.() === 0) return 'agent has no free scratch slot';
    if (options.maxSandboxes) {
      const running = await runtime.count().catch(() => Number.POSITIVE_INFINITY);
      if (running + creating > options.maxSandboxes) return `agent is full (${options.maxSandboxes} sandboxes)`;
    }
    if (options.maxMemoryMb) {
      const inUse = await runtime.memoryMb().catch(() => Number.POSITIVE_INFINITY);
      if (inUse + creatingMemoryMb > options.maxMemoryMb) {
        return `agent memory budget is full (${options.maxMemoryMb} MiB; ${memoryMb} MiB requested)`;
      }
    }
    return undefined;
  };

  if (metricsExpected) {
    app.get(METRICS_PATH, async (_req, reply) => {
      const running = await runtime.count().catch(() => -1);
      const lines = [
        '# HELP winnowl_agent_sandboxes Sandbox containers running on this host (-1: docker unreachable).',
        '# TYPE winnowl_agent_sandboxes gauge',
        `winnowl_agent_sandboxes ${running}`,
        '# HELP winnowl_agent_max_sandboxes Sandbox cap of this host (0: none).',
        '# TYPE winnowl_agent_max_sandboxes gauge',
        `winnowl_agent_max_sandboxes ${options.maxSandboxes ?? 0}`,
        '# HELP winnowl_agent_sandbox_memory_mb Memory limits of running sandboxes, summed (MiB; -1: docker unreachable).',
        '# TYPE winnowl_agent_sandbox_memory_mb gauge',
        `winnowl_agent_sandbox_memory_mb ${await runtime.memoryMb().catch(() => -1)}`,
        '# HELP winnowl_agent_max_memory_mb Sandbox memory budget of this host (MiB; 0: none).',
        '# TYPE winnowl_agent_max_memory_mb gauge',
        `winnowl_agent_max_memory_mb ${options.maxMemoryMb ?? 0}`,
        ...(await scratchMetrics()),
        '# HELP winnowl_agent_draining 1 while the agent drains for shutdown.',
        '# TYPE winnowl_agent_draining gauge',
        `winnowl_agent_draining ${options.draining?.() ? 1 : 0}`,
        '# HELP winnowl_agent_workspaces Open workspaces (clones) on this host.',
        '# TYPE winnowl_agent_workspaces gauge',
        `winnowl_agent_workspaces ${options.workspaces?.count() ?? 0}`,
        '# HELP winnowl_agent_failures_total Failed operations by kind.',
        '# TYPE winnowl_agent_failures_total counter',
        ...Object.entries(failures).map(([kind, n]) => `winnowl_agent_failures_total{kind="${kind}"} ${n}`),
        '',
      ];
      return reply.type('text/plain; version=0.0.4').send(lines.join('\n'));
    });
  }
  async function scratchMetrics(): Promise<string[]> {
    if (!runtime.scratchStatus) return [];
    const s = await runtime.scratchStatus().catch(() => undefined);
    return [
      '# HELP winnowl_agent_scratch_free_mb Disk a new or growing sandbox can get (MiB; -1: quota service unreachable).',
      '# TYPE winnowl_agent_scratch_free_mb gauge',
      `winnowl_agent_scratch_free_mb ${s?.freeMb ?? -1}`,
      '# HELP winnowl_agent_scratch_host_free_mb Free space of the disk under the sparse scratch image (MiB; -1: unknown).',
      '# TYPE winnowl_agent_scratch_host_free_mb gauge',
      `winnowl_agent_scratch_host_free_mb ${s?.hostFreeMb ?? -1}`,
    ];
  }
  const countFailure = <T>(kind: keyof typeof failures, p: Promise<T>): Promise<T> => {
    p.catch(() => (failures[kind] += 1));
    return p;
  };

  app.post(`${AGENT_API_PREFIX}/sandboxes`, async (req, reply) => {
    const body = req.body as AgentCreateRequest | undefined;
    const spec = body?.spec;
    if (!spec || typeof spec.image !== 'string')
      return reply.code(400).send(agentError(400, 'spec required'));
    if (!options.allowedImages.has(spec.image)) {
      return reply.code(400).send(agentError(400, `image not allowed: ${spec.image}`));
    }
    // Direct bridge networking would bypass the VM's egress proxy; no review path needs it.
    if (spec.network?.mode === 'full') {
      return reply.code(400).send(agentError(400, 'network mode full is not allowed'));
    }
    if (options.draining?.()) return reply.code(503).send(agentError(503, 'agent is draining'));
    // A workspace mounted read-only instead of copied: only one of this host's own, only under /workspace.
    const binds: { src: string; dst: string }[] = [];
    if (spec.mountWorkspace !== undefined) {
      const m = spec.mountWorkspace as { workspaceId?: unknown; dest?: unknown };
      const headDir =
        typeof m.workspaceId === 'string' && WORKSPACE_ID.test(m.workspaceId) ? options.workspaces?.headDir(m.workspaceId) : undefined;
      const dest = typeof m.dest === 'string' ? posix.normalize(m.dest) : '';
      const roots = options.workspaceHostRoot;
      if (!headDir) return reply.code(404).send(agentError(404, 'unknown workspace'));
      if (!dest.startsWith('/workspace/') || dest.includes('..')) {
        return reply.code(400).send(agentError(400, 'mountWorkspace.dest must be under /workspace'));
      }
      if (!roots || !headDir.startsWith(`${roots.container}/`)) {
        return reply.code(400).send(agentError(400, 'this agent cannot mount workspaces'));
      }
      binds.push({ src: `${roots.host}${headDir.slice(roots.container.length)}`, dst: dest });
    }
    const disk = spec.resources?.workspace === 'disk';
    if (options.maxSandboxes || options.maxMemoryMb || (disk && runtime.scratchFree?.() !== undefined)) {
      // Counted before the await, so concurrent creates see each other; a race can only refuse
      // one that would have fit, never admit one too many.
      const memoryMb = Number(spec.resources?.memoryMb) || 0;
      creating += 1;
      creatingMemoryMb += memoryMb;
      const release = () => {
        creating -= 1;
        creatingMemoryMb -= memoryMb;
      };
      const refused = await refusal(memoryMb, disk);
      if (refused) {
        release();
        return reply.code(503).send(agentError(503, refused));
      }
      const created = countFailure('sandbox_create', runtime.create(spec, body.owner, binds));
      void created.then(release, release);
      return streamResult(reply, pingMs, created);
    }
    return streamResult(reply, pingMs, countFailure('sandbox_create', runtime.create(spec, body.owner, binds)));
  });

  // Growing memory must fit the budget like a create; disk is checked by the slot pool (503 when full).
  app.post(`${AGENT_API_PREFIX}/sandboxes/:id/resize`, async (req, reply) => {
    const id = sandboxId(req.params);
    if (!id) return reply.code(404).send(agentError(404, 'unknown sandbox'));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const resize: SandboxResize = {};
    for (const key of ['cpus', 'memoryMb', 'swapMb', 'diskMb'] as const) {
      if (body[key] === undefined) continue;
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0 || (key !== 'swapMb' && n === 0)) return reply.code(400).send(agentError(400, `invalid ${key}`));
      resize[key] = key === 'cpus' ? n : Math.ceil(n);
    }
    if (body.stopProcesses === true) resize.stopProcesses = true;
    let grow = 0;
    if (resize.memoryMb !== undefined && options.maxMemoryMb) {
      grow = Math.max(0, resize.memoryMb - (await runtime.usage(id)).memoryMb);
      creatingMemoryMb += grow;
    }
    try {
      if (grow > 0) {
        const inUse = await runtime.memoryMb().catch(() => Number.POSITIVE_INFINITY);
        if (inUse + creatingMemoryMb > options.maxMemoryMb!) {
          return reply.code(503).send(agentError(503, `agent memory budget is full (${options.maxMemoryMb} MiB; ${grow} MiB more requested)`));
        }
      }
      return await runtime.resize(id, resize);
    } catch (err) {
      if ((err as { code?: string }).code === 'capacity_exhausted') return reply.code(503).send(agentError(503, (err as Error).message));
      throw err;
    } finally {
      creatingMemoryMb -= grow;
    }
  });

  app.get(`${AGENT_API_PREFIX}/sandboxes/:id/usage`, async (req, reply) => {
    const id = sandboxId(req.params);
    if (!id) return reply.code(404).send(agentError(404, 'unknown sandbox'));
    return runtime.usage(id);
  });

  app.post(`${AGENT_API_PREFIX}/sandboxes/:id/execs`, async (req, reply) => {
    const id = sandboxId(req.params);
    if (!id) return reply.code(404).send(agentError(404, 'unknown sandbox'));
    const execReq = req.body as ExecRequest | undefined;
    if (!execReq || !Array.isArray(execReq.argv) || execReq.argv.length === 0) {
      return reply.code(400).send(agentError(400, 'argv required'));
    }
    const execId = randomUUID();
    // The exec belongs to the agent, not to this request: a dropped connection re-attaches by id.
    const entry: ExecEntry = { sandboxId: id, done: runtime.exec(id, execReq) };
    entry.done.then(
      () => (entry.finishedAt = Date.now()),
      () => (entry.finishedAt = Date.now()),
    );
    execs.set(execId, entry);
    return streamResult(reply, pingMs, entry.done, { event: 'started', data: { execId } });
  });

  app.get(`${AGENT_API_PREFIX}/sandboxes/:id/execs/:execId`, async (req, reply) => {
    const id = sandboxId(req.params);
    const entry = execs.get((req.params as { execId: string }).execId);
    if (!id || !entry || entry.sandboxId !== id)
      return reply.code(404).send(agentError(404, 'unknown exec'));
    return streamResult(reply, pingMs, entry.done);
  });

  app.put(
    `${AGENT_API_PREFIX}/sandboxes/:id/files`,
    { bodyLimit: FILE_BODY_LIMIT },
    async (req, reply) => {
      const id = sandboxId(req.params);
      const path = (req.query as { path?: string }).path;
      if (!id) return reply.code(404).send(agentError(404, 'unknown sandbox'));
      if (!path || typeof req.body !== 'string')
        return reply.code(400).send(agentError(400, 'path and text body required'));
      await runtime.putFile(id, { path, content: req.body });
      return reply.code(204).send();
    },
  );

  app.get(`${AGENT_API_PREFIX}/sandboxes/:id/files`, async (req, reply) => {
    const id = sandboxId(req.params);
    const path = (req.query as { path?: string }).path;
    if (!id) return reply.code(404).send(agentError(404, 'unknown sandbox'));
    if (!path) return reply.code(400).send(agentError(400, 'path required'));
    return runtime.getArtifact(id, path);
  });

  app.put(`${AGENT_API_PREFIX}/sandboxes/:id/tree`, async (req, reply) => {
    const id = sandboxId(req.params);
    const raw = (req.query as { dest?: string }).dest;
    const dest = raw ? posix.normalize(raw) : undefined;
    if (!id) return reply.code(404).send(agentError(404, 'unknown sandbox'));
    if (!dest || (dest !== '/workspace' && !dest.startsWith('/workspace/'))) {
      return reply.code(400).send(agentError(400, 'dest must be under /workspace'));
    }
    await runtime.extractTar(id, req.body as Readable, dest);
    return reply.code(204).send();
  });

  const workspaces = options.workspaces;
  if (workspaces) {
    const workspaceId = (params: unknown): string | undefined => {
      const id = (params as { id?: string }).id;
      return id && WORKSPACE_ID.test(id) ? id : undefined;
    };

    app.post(`${AGENT_API_PREFIX}/workspaces`, async (req, reply) => {
      const body = req.body as AgentWorkspaceOpenRequest | undefined;
      const request = parseWorkspaceRequest(body?.request);
      if (typeof request === 'string') return reply.code(400).send(agentError(400, request));
      if (options.draining?.()) return reply.code(503).send(agentError(503, 'agent is draining'));
      if (options.maxWorkspaces && workspaces.count() >= options.maxWorkspaces) {
        return reply.code(503).send(agentError(503, `agent is full (${options.maxWorkspaces} workspaces)`));
      }
      // A clone can take minutes: answered over SSE like a sandbox create.
      return streamResult(reply, pingMs, countFailure('workspace_open', workspaces.open(request, body?.owner)));
    });

    app.post(`${AGENT_API_PREFIX}/workspaces/:id/ops`, async (req, reply) => {
      const id = workspaceId(req.params);
      if (!id) return reply.code(404).send(agentError(404, 'unknown workspace'));
      const op = req.body as CodePlaneRequest | undefined;
      if (!op || typeof op.op !== 'string') return reply.code(400).send(agentError(400, 'op required'));
      try {
        return (await workspaces.op(id, op)) ?? null;
      } catch (err) {
        if (err instanceof UnknownWorkspaceError) return reply.code(404).send(agentError(404, err.message));
        throw err;
      }
    });

    app.delete(`${AGENT_API_PREFIX}/workspaces/:id`, async (req, reply) => {
      const id = workspaceId(req.params);
      if (!id) return reply.code(404).send(agentError(404, 'unknown workspace'));
      await workspaces.close(id);
      return reply.code(204).send();
    });

    // The worktree never leaves this host: a local tar into the sandbox, no network transfer.
    app.post(`${AGENT_API_PREFIX}/sandboxes/:id/tree-from-workspace`, async (req, reply) => {
      const id = sandboxId(req.params);
      const body = req.body as Partial<AgentTreeFromWorkspaceRequest> | undefined;
      const dest = typeof body?.dest === 'string' ? posix.normalize(body.dest) : undefined;
      if (!id) return reply.code(404).send(agentError(404, 'unknown sandbox'));
      const headDir = typeof body?.workspaceId === 'string' && WORKSPACE_ID.test(body.workspaceId)
        ? workspaces.headDir(body.workspaceId)
        : undefined;
      if (!headDir) return reply.code(404).send(agentError(404, 'unknown workspace'));
      if (!dest || (dest !== '/workspace' && !dest.startsWith('/workspace/'))) {
        return reply.code(400).send(agentError(400, 'dest must be under /workspace'));
      }
      const tar = tarDirectory(headDir);
      try {
        await runtime.extractTar(id, tar.stream, dest);
      } catch (err) {
        tar.abort();
        throw err;
      }
      await tar.done;
      return reply.code(204).send();
    });
  }

  app.delete(`${AGENT_API_PREFIX}/sandboxes/:id`, async (req, reply) => {
    const id = sandboxId(req.params);
    if (!id) return reply.code(404).send(agentError(404, 'unknown sandbox'));
    await runtime.destroy(id);
    return reply.code(204).send();
  });

  app.post(`${AGENT_API_PREFIX}/sweep`, async (req) => {
    const body = (req.body ?? {}) as Partial<AgentSweepRequest>;
    const olderThanMs = Number(body.olderThanMs);
    const liveOwners = Array.isArray(body.liveOwners) ? new Set(body.liveOwners) : undefined;
    const removed = await runtime.sweep(
      Number.isFinite(olderThanMs) && olderThanMs >= 0 ? olderThanMs : 60 * 60_000,
      liveOwners,
    );
    return { removed: removed + ((await workspaces?.sweep(liveOwners)) ?? 0) };
  });

  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = (err as Error)?.message ?? String(err);
    app.log.warn({ err: message }, 'request failed');
    void reply.code(status).send(agentError(status, message));
  });

  return app;
}

function scratchField(free: number | undefined): { scratchFree?: number } {
  return free === undefined ? {} : { scratchFree: free };
}

function mbField(free: number | undefined): { scratchFreeMb?: number } {
  return free === undefined ? {} : { scratchFreeMb: free };
}

function agentError(status: number, message: string): AgentError {
  return { status, message };
}

/**
 * Answer with SSE: headers now, `: ping` every `pingMs`, then `result` or `error`.
 * A client that disconnects only stops the writes; the underlying operation keeps running.
 */
function streamResult<T>(
  reply: FastifyReply,
  pingMs: number,
  work: Promise<T>,
  first?: { event: string; data: unknown },
): FastifyReply {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });
  if (first) res.write(formatSseEvent(first.event, first.data));
  else res.write(': open\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), pingMs);
  const finish = (chunk: string): void => {
    clearInterval(ping);
    if (!res.writableEnded) res.end(chunk);
  };
  res.on('close', () => clearInterval(ping));
  work.then(
    (value) => finish(formatSseEvent('result', value)),
    (err: unknown) =>
      finish(
        formatSseEvent(
          'error',
          // A typed failure keeps its meaning across the wire (422 = the request can never succeed).
          agentError(
            (err as { code?: string }).code === 'repository_invalid'
              ? 422
              : // Out of room (a scratch slot taken by a concurrent create): the pool waits and retries.
                (err as { code?: string }).code === 'capacity_exhausted'
                ? 503
                : 500,
            (err as Error)?.message ?? String(err),
          ),
        ),
      ),
  );
  return reply;
}
