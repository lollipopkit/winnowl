import { AgentRequestError, HttpSandboxBackend } from './http-backend.js';
import type { AgentHealth, AgentWorkspaceOpenResult } from './agent-protocol.js';
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

export interface AgentPoolHost {
  /** Stable; part of every handle and the input of its token. */
  name: string;
  /** Agent origin, e.g. `http://100.64.0.2:8790`. */
  url: string;
  /** The agent enforces the same cap. */
  slots: number;
}

/** The subset of `HttpSandboxBackend` the pool drives (test seam). */
export type AgentClient = SandboxBackend &
  Required<Pick<SandboxBackend, 'copyInto' | 'sweepOrphans' | 'resize' | 'usage'>> & {
    health(): Promise<AgentHealth>;
    openWorkspace(request: unknown): Promise<AgentWorkspaceOpenResult>;
    workspaceOp(workspaceId: string, op: unknown): Promise<unknown>;
    closeWorkspace(workspaceId: string): Promise<void>;
    copyTreeFromWorkspace(handle: SandboxHandle, workspaceId: string, destContainerDir: string): Promise<void>;
  };

export interface PoolWorkspace {
  host: string;
  id: string;
  info: unknown;
  op(req: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface AgentPoolOptions {
  hosts: readonly AgentPoolHost[];
  /** Its sha256 is configured on that agent. */
  tokenFor: (host: string) => string;
  /** Worker id; owner label of every sandbox for orphan sweeps. */
  ownerId?: string;
  /** Only agents of this version get new sandboxes (the in-sandbox executor must match). Omit to accept any. */
  version?: string;
  /** How long `create` waits for a free slot before failing. Default 10 min. */
  waitMs?: number;
  /** Health answers are reused this long. Default 3 s. */
  healthTtlMs?: number;
  /** A waiting sandbox older than this keeps its hosts for itself (no backfill). Default 60 s. */
  agingMs?: number;
  /** How long a growing sandbox waits for room on its host before the resize fails. Default 5 min. */
  resizeWaitMs?: number;
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
  clientFor?: (host: AgentPoolHost, token: string) => AgentClient;
}

const RETRY_MS = 5_000;

/** No usable host had room within the wait. Transient (deploys, busy hours), so the job is retried. */
export class SandboxCapacityError extends Error {
  override readonly name = 'SandboxCapacityError';
}
/** Re-check interval while sandboxes wait, even without an event. */
const PUMP_MS = 2_000;

interface HostState {
  usable: boolean;
  at: number;
  sandboxes: number;
  maxSandboxes: number;
  memoryMb?: number;
  maxMemoryMb?: number;
  scratchFree?: number;
  scratchFreeMb?: number;
}

interface Demand {
  memoryMb: number;
  diskMb: number;
  /** Counts against the sandbox cap. */
  sandbox: boolean;
  /** Needs a disk-quota slot (`workspace: 'disk'`) where the host has slots. */
  slot: boolean;
}

interface Waiter {
  demand: Demand;
  priority: number;
  since: number;
  deadline: number;
  hosts: string[];
  /** A 503 puts it back in the queue. */
  run: (host: string) => Promise<void>;
  reject: (err: Error) => void;
  timeoutMessage: string;
}

interface Placed {
  host: string;
  memoryMb: number;
  diskMb: number;
  priority: number;
}

/**
 * `SandboxBackend` over a fixed set of sandbox hosts (`SANDBOX_BACKEND=agents`).
 *
 * Placement uses each host's `/health` (sandboxes, memory budget, free slots) plus in-flight creates.
 * Sandboxes that fit nowhere wait in one queue by priority, then arrival; a smaller one may pass a
 * larger one until the larger has waited `agingMs`, after which it goes first and its hosts are kept
 * for it. `spec.placement` pins a host. The agent's own 503 is the backstop (other runners share hosts).
 * Growing (`resize`) waits in the same queue; shrinking frees room at once.
 * Handles carry the host as `containerId = "<host>/<container>"`, so calls route without shared state.
 */
export class AgentPoolSandboxBackend implements SandboxBackend {
  readonly capacity: number;
  private readonly hosts: Map<string, AgentPoolHost>;
  private readonly clients = new Map<string, AgentClient>();
  private readonly placed = new Map<string, Placed>();
  private readonly health = new Map<string, HostState>();
  /** Not yet reflected in the host's `/health` counts. */
  private readonly pending = new Map<string, Demand[]>();
  private readonly waiters: Waiter[] = [];
  /** Hosts that just answered 503 are skipped until then. */
  private readonly refusedUntil = new Map<string, number>();
  private pumping = false;
  private pumpAgain = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly log: NonNullable<AgentPoolOptions['log']>;

  constructor(private readonly o: AgentPoolOptions) {
    if (o.hosts.length === 0) throw new Error('agent pool needs at least one host');
    this.hosts = new Map(o.hosts.map((h) => [h.name, h]));
    if (this.hosts.size !== o.hosts.length) throw new Error('agent pool host names must be unique');
    for (const h of o.hosts) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(h.name)) throw new Error(`invalid agent host name: ${h.name}`);
      if (!(h.slots > 0)) throw new Error(`agent host ${h.name} needs slots > 0`);
    }
    this.capacity = o.hosts.reduce((n, h) => n + h.slots, 0);
    this.log = o.log ?? (() => undefined);
  }

  /**
   * Opens a workspace on the least loaded usable host; the job's sandboxes then use
   * `spec.placement = workspace.host` and `copyFromWorkspace`. Workspaces take no sandbox slot.
   */
  async openWorkspace(request: unknown): Promise<PoolWorkspace> {
    const deadline = Date.now() + (this.o.waitMs ?? 10 * 60_000);
    for (;;) {
      const hosts = [...this.hosts.values()].sort((a, b) => this.load(a.name) - this.load(b.name) || a.name.localeCompare(b.name));
      for (const host of hosts) {
        if (!(await this.usable(host))) continue;
        const client = this.client(host);
        try {
          const opened = await client.openWorkspace(request);
          return {
            host: host.name,
            id: opened.id,
            info: opened.info,
            op: (req) => client.workspaceOp(opened.id, req),
            close: () => client.closeWorkspace(opened.id),
          };
        } catch (err) {
          if (err instanceof AgentRequestError && err.status === 503) continue;
          if (err instanceof AgentRequestError) throw err;
          this.markDown(host.name);
          this.log('warn', 'sandbox host failed to open a workspace; trying another', {
            host: host.name,
            err: (err as Error).message,
          });
        }
      }
      if (Date.now() >= deadline) throw new SandboxCapacityError('no sandbox host could open a workspace in time');
      await sleep(Math.min(RETRY_MS, Math.max(0, deadline - Date.now())));
    }
  }

  copyFromWorkspace(
    handle: SandboxHandle,
    workspace: { host: string; workspaceId: string },
    destContainerDir: string,
  ): Promise<void> {
    const host = this.hostOf(handle);
    if (host !== workspace.host) {
      return Promise.reject(new Error(`sandbox on ${host} cannot read a workspace on ${workspace.host}`));
    }
    return this.route(handle).copyTreeFromWorkspace(handle, workspace.workspaceId, destContainerDir);
  }

  create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (spec.placement !== undefined && !this.hosts.has(spec.placement)) {
      return Promise.reject(new Error(`unknown sandbox host: ${spec.placement}`));
    }
    const disk = spec.resources.workspace === 'disk';
    const priority = spec.priority ?? 0;
    return new Promise<SandboxHandle>((resolve, reject) => {
      const now = Date.now();
      this.waiters.push({
        demand: { memoryMb: spec.resources.memoryMb, diskMb: disk ? spec.resources.diskMb : 0, sandbox: true, slot: disk },
        priority,
        since: now,
        deadline: now + (this.o.waitMs ?? 10 * 60_000),
        hosts: this.candidateNames(spec.placement),
        run: async (host) => {
          const handle = await this.client(this.hosts.get(host)!).create(spec);
          this.placed.set(handle.id, { host, memoryMb: spec.resources.memoryMb, diskMb: disk ? spec.resources.diskMb : 0, priority });
          resolve({ id: handle.id, containerId: `${host}/${handle.containerId}` });
        },
        reject,
        timeoutMessage:
          spec.placement !== undefined
            ? `sandbox host ${spec.placement} had no free slot in time`
            : `no sandbox host had a free slot in time (capacity ${this.capacity})`,
      });
      this.pump();
    });
  }

  /** Growth waits for room on its host like a create; a pure shrink applies at once. */
  async resize(handle: SandboxHandle, req: SandboxResize): Promise<SandboxUsage> {
    const host = this.hostOf(handle);
    const client = this.route(handle);
    let cur = this.placed.get(handle.id);
    if (!cur) {
      // Placed by an earlier process: ask the host what it has.
      const u = await client.usage(handle);
      cur = { host, memoryMb: u.memoryMb, diskMb: u.diskMb ?? 0, priority: 0 };
      this.placed.set(handle.id, cur);
    }
    const placed = cur;
    const apply = async (): Promise<SandboxUsage> => {
      const u = await client.resize(handle, req);
      this.placed.set(handle.id, { ...placed, memoryMb: u.memoryMb, diskMb: u.diskMb ?? 0 });
      return u;
    };
    const demand: Demand = {
      memoryMb: Math.max(0, (req.memoryMb ?? cur.memoryMb) - cur.memoryMb),
      diskMb: Math.max(0, (req.diskMb ?? cur.diskMb) - cur.diskMb),
      sandbox: false,
      slot: false,
    };
    if (demand.memoryMb === 0 && demand.diskMb === 0) {
      try {
        return await apply();
      } finally {
        this.markStale(host);
        this.pump();
      }
    }
    return new Promise<SandboxUsage>((resolve, reject) => {
      const now = Date.now();
      this.waiters.push({
        demand,
        priority: cur.priority,
        since: now,
        deadline: now + (this.o.resizeWaitMs ?? 5 * 60_000),
        hosts: [host],
        run: async () => resolve(await apply()),
        reject,
        timeoutMessage: `sandbox host ${host} had no room to grow the sandbox in time`,
      });
      this.pump();
    });
  }

  usage(handle: SandboxHandle): Promise<SandboxUsage> {
    return this.route(handle).usage(handle);
  }

  /** Calls arriving meanwhile trigger one more run afterwards. */
  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void this.place()
      .catch((err: unknown) => this.log('warn', 'sandbox placement failed', { err: (err as Error).message }))
      .finally(() => {
        this.pumping = false;
        if (this.pumpAgain) {
          this.pumpAgain = false;
          this.pump();
        } else if (this.waiters.length > 0 && !this.timer) {
          // Nothing fits now: look again shortly (hosts change without telling us).
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.pump();
          }, PUMP_MS);
          this.timer.unref?.();
        }
      });
  }

  private async place(): Promise<void> {
    if (this.waiters.length === 0) return;
    const wanted = new Set(this.waiters.flatMap((w) => w.hosts));
    await Promise.all([...wanted].map((name) => this.state(name)));

    const now = Date.now();
    const aging = this.o.agingMs ?? 60_000;
    const aged = (w: Waiter): boolean => now - w.since >= aging;
    // Long waiters first regardless of priority (priority alone would starve a big sandbox), then by
    // priority, then arrival.
    const ordered = [
      ...this.waiters.filter(aged).sort((a, b) => a.since - b.since),
      ...this.waiters.filter((w) => !aged(w)).sort((a, b) => b.priority - a.priority || a.since - b.since),
    ];
    // Hosts kept for a long waiter: nothing after it is placed there.
    const held = new Set<string>();
    for (const w of ordered) {
      const candidates = w.hosts;
      const fitting = candidates
        .filter((name) => !held.has(name) && (this.refusedUntil.get(name) ?? 0) <= now && this.fits(name, w.demand))
        .sort((a, b) => this.load(a) - this.load(b) || a.localeCompare(b));
      const host = fitting[0];
      if (host !== undefined) {
        this.dropWaiter(w);
        this.dispatch(w, host);
      } else if (aged(w)) {
        for (const name of candidates) held.add(name);
      }
    }
    // Only after a placement attempt, so every sandbox gets at least one try.
    for (const w of [...this.waiters]) {
      if (now < w.deadline) continue;
      this.dropWaiter(w);
      w.reject(new SandboxCapacityError(w.timeoutMessage));
    }
  }

  private dispatch(w: Waiter, host: string): void {
    const inFlight = this.pending.get(host) ?? [];
    inFlight.push(w.demand);
    this.pending.set(host, inFlight);
    void w
      .run(host)
      .then(
        () => undefined,
        (err: unknown) => {
          if (err instanceof AgentRequestError && err.status === 503) {
            // The host was fuller than it looked (another runner, a slot still clearing): wait again and
            // skip that host for a moment.
            this.refusedUntil.set(host, Date.now() + PUMP_MS);
            this.waiters.push(w);
          } else if (err instanceof AgentRequestError) {
            w.reject(err); // the request itself was refused
          } else {
            // Unreachable or dropped mid-create (the owner-label sweep reclaims a possibly created container):
            // take the host out until its next health check.
            this.markDown(host);
            this.log('warn', 'sandbox host failed; trying another', { host, err: (err as Error).message });
            this.waiters.push(w);
          }
        },
      )
      .finally(() => {
        inFlight.splice(inFlight.indexOf(w.demand), 1);
        this.markStale(host);
        this.pump();
      });
  }

  private dropWaiter(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  private fits(host: string, demand: Demand): boolean {
    const s = this.health.get(host);
    if (!s?.usable) return false;
    const inFlight = this.pending.get(host) ?? [];
    if (demand.sandbox && s.sandboxes + inFlight.filter((d) => d.sandbox).length + 1 > s.maxSandboxes) return false;
    if (s.maxMemoryMb !== undefined) {
      const used = (s.memoryMb ?? 0) + inFlight.reduce((n, d) => n + d.memoryMb, 0);
      if (used + demand.memoryMb > s.maxMemoryMb) return false;
    }
    if (demand.slot && s.scratchFree !== undefined) {
      if (s.scratchFree - inFlight.filter((d) => d.slot).length < 1) return false;
    }
    if (demand.diskMb > 0 && s.scratchFreeMb !== undefined) {
      if (s.scratchFreeMb - inFlight.reduce((n, d) => n + d.diskMb, 0) < demand.diskMb) return false;
    }
    return true;
  }

  /** Placement prefers the emptiest host. */
  private load(host: string): number {
    const s = this.health.get(host);
    const max = s?.maxSandboxes ?? this.hosts.get(host)!.slots;
    return ((s?.sandboxes ?? 0) + (this.pending.get(host)?.filter((d) => d.sandbox).length ?? 0)) / max;
  }

  private candidateNames(placement: string | undefined): string[] {
    return placement !== undefined ? [placement] : [...this.hosts.keys()];
  }

  exec(handle: SandboxHandle, req: ExecRequest): Promise<ExecResult> {
    return this.route(handle).exec(handle, req);
  }

  putFile(handle: SandboxHandle, req: PutFileRequest): Promise<void> {
    return this.route(handle).putFile(handle, req);
  }

  getArtifact(handle: SandboxHandle, path: string): Promise<ArtifactContent> {
    return this.route(handle).getArtifact(handle, path);
  }

  copyInto(handle: SandboxHandle, srcHostDir: string, destContainerDir: string): Promise<void> {
    return this.route(handle).copyInto(handle, srcHostDir, destContainerDir);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    try {
      await this.route(handle).destroy(handle);
    } finally {
      const host = this.placed.get(handle.id)?.host;
      this.placed.delete(handle.id);
      if (host) {
        // Room freed: place waiting sandboxes now.
        this.markStale(host);
        this.pump();
      }
    }
  }

  /** Hosts that are down are skipped (their containers have lifetime caps). */
  async sweepOrphans(olderThanMs: number, liveOwners?: ReadonlySet<string>): Promise<number> {
    const counts = await Promise.all(
      [...this.hosts.values()].map((host) =>
        this.client(host)
          .sweepOrphans(olderThanMs, liveOwners)
          .catch((err) => {
            this.log('warn', 'sandbox host sweep failed', { host: host.name, err: (err as Error).message });
            return 0;
          }),
      ),
    );
    return counts.reduce((a, b) => a + b, 0);
  }

  hostOf(handle: SandboxHandle): string {
    const name = handle.containerId.split('/')[0] ?? '';
    if (!this.hosts.has(name)) throw new Error(`not a sandbox of this pool: ${handle.containerId}`);
    return name;
  }

  /** Refreshed when older than the health TTL or marked stale. */
  private async state(name: string): Promise<HostState> {
    const cached = this.health.get(name);
    if (cached && Date.now() - cached.at < (this.o.healthTtlMs ?? 3_000)) return cached;
    const host = this.hosts.get(name)!;
    let state: HostState = { usable: false, at: Date.now(), sandboxes: 0, maxSandboxes: host.slots };
    try {
      const h = await this.client(host).health();
      const usable = !h.draining && (this.o.version === undefined || h.version === this.o.version);
      if (this.o.version !== undefined && h.version !== this.o.version) {
        this.log('info', 'sandbox host runs another version; not placing there', {
          host: name,
          agent: h.version,
          expected: this.o.version,
        });
      }
      state = {
        usable,
        at: Date.now(),
        sandboxes: h.sandboxes,
        // The tighter of what the deploy configured and what the agent enforces.
        maxSandboxes: Math.min(host.slots, h.maxSandboxes ?? host.slots),
        ...(h.memoryMb !== undefined ? { memoryMb: h.memoryMb } : {}),
        ...(h.maxMemoryMb !== undefined ? { maxMemoryMb: h.maxMemoryMb } : {}),
        ...(h.scratchFree !== undefined ? { scratchFree: h.scratchFree } : {}),
        ...(h.scratchFreeMb !== undefined ? { scratchFreeMb: h.scratchFreeMb } : {}),
      };
    } catch (err) {
      this.log('warn', 'sandbox host health check failed', { host: name, err: (err as Error).message });
    }
    this.health.set(name, state);
    return state;
  }

  private async usable(host: AgentPoolHost): Promise<boolean> {
    return (await this.state(host.name)).usable;
  }

  private markStale(host: string): void {
    const s = this.health.get(host);
    if (s) this.health.set(host, { ...s, at: 0 });
  }

  private markDown(host: string): void {
    const s = this.health.get(host);
    this.health.set(host, { ...(s ?? { sandboxes: 0, maxSandboxes: this.hosts.get(host)!.slots }), usable: false, at: Date.now() });
  }

  private route(handle: SandboxHandle): AgentClient {
    return this.client(this.hosts.get(this.hostOf(handle))!);
  }

  private client(host: AgentPoolHost): AgentClient {
    let c = this.clients.get(host.name);
    if (!c) {
      const token = this.o.tokenFor(host.name);
      c =
        this.o.clientFor?.(host, token) ??
        new HttpSandboxBackend({
          baseUrl: host.url,
          token,
          ...(this.o.ownerId ? { ownerId: this.o.ownerId } : {}),
          log: (message, data) => this.log('warn', message, { host: host.name, ...data }),
        });
      this.clients.set(host.name, c);
    }
    return c;
  }
}

/** Parses `SANDBOX_AGENTS`: comma-separated `name=url=slots`, e.g. `sandbox-1=http://100.64.0.2:8790=8`. */
export function parseAgentHosts(value: string): AgentPoolHost[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = /^([^=]+)=(https?:\/\/[^=]+)=(\d+)$/.exec(entry);
      if (!m) throw new Error(`SANDBOX_AGENTS entry must be name=url=slots: ${entry}`);
      return { name: m[1]!, url: m[2]!, slots: Number(m[3]) };
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
