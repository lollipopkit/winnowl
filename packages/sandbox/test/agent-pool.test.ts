import { describe, expect, it } from 'vitest';
import {
  AgentPoolSandboxBackend,
  AgentRequestError,
  parseAgentHosts,
  type AgentClient,
  type AgentPoolHost,
  type SandboxResize,
  type SandboxSpec,
} from '../src/index.js';

const spec: SandboxSpec = {
  image: 'winnowl:latest',
  network: { mode: 'allowlist', hosts: [] },
  resources: { cpus: 0.5, memoryMb: 512, pids: 64, diskMb: 1024 },
};

/** In-memory agent: `full` answers 503, `down` throws like an unreachable host. */
class FakeAgent implements AgentClient {
  created = 0;
  destroyed: string[] = [];
  /** Running sandboxes and their memory, as `/health` reports them. */
  live = new Map<string, { memoryMb: number; disk: boolean; diskMb: number }>();
  full = false;
  down = false;
  version = 'v1';
  draining = false;
  maxMemoryMb: number | undefined;
  scratchSlots: number | undefined;
  scratchPoolMb: number | undefined;
  resizes: SandboxResize[] = [];
  constructor(readonly name: string) {}
  async health() {
    if (this.down) throw new Error('connect ECONNREFUSED');
    const live = [...this.live.values()];
    return {
      version: this.version,
      sandboxes: live.length,
      ...(this.draining ? { draining: true } : {}),
      ...(this.maxMemoryMb !== undefined
        ? { maxMemoryMb: this.maxMemoryMb, memoryMb: live.reduce((n, s) => n + s.memoryMb, 0) }
        : {}),
      ...(this.scratchSlots !== undefined ? { scratchFree: this.scratchSlots - live.filter((s) => s.disk).length } : {}),
      ...(this.scratchPoolMb !== undefined ? { scratchFreeMb: this.scratchPoolMb - live.reduce((n, s) => n + s.diskMb, 0) } : {}),
    };
  }
  async create(s: SandboxSpec) {
    if (this.down) throw new Error('connect ECONNREFUSED');
    if (this.full) throw new AgentRequestError(503, 'agent is full');
    this.created += 1;
    const id = `rvb-${this.name}-${this.created}`;
    const disk = s.resources.workspace === 'disk';
    this.live.set(id, { memoryMb: s.resources.memoryMb, disk, diskMb: disk ? s.resources.diskMb : 0 });
    return { id, containerId: id };
  }
  async resize(h: { id: string }, req: SandboxResize) {
    if (this.full) throw new AgentRequestError(503, 'agent is full');
    this.resizes.push(req);
    const cur = this.live.get(h.id)!;
    this.live.set(h.id, { ...cur, memoryMb: req.memoryMb ?? cur.memoryMb, diskMb: req.diskMb ?? cur.diskMb });
    return this.usage(h);
  }
  async usage(h: { id: string }) {
    const cur = this.live.get(h.id)!;
    return { cpus: 1, memoryMb: cur.memoryMb, swapMb: 0, diskMb: cur.diskMb, memoryUsedMb: 0, memoryPeakMb: 0, oomKills: 0 };
  }
  async exec() {
    return { exitCode: 0, stdout: this.name } as never;
  }
  async putFile() {}
  async getArtifact() {
    return { path: '', content: this.name, bytes: 0 };
  }
  async copyInto() {}
  async destroy(h: { id: string }) {
    this.destroyed.push(h.id);
    this.live.delete(h.id);
  }
  async sweepOrphans() {
    if (this.down) throw new Error('down');
    return 1;
  }
  workspaces: string[] = [];
  copies: { sandbox: string; workspace: string }[] = [];
  async openWorkspace() {
    if (this.down) throw new Error('connect ECONNREFUSED');
    if (this.full) throw new AgentRequestError(503, 'agent is full');
    const id = `ws-${this.name}-${this.workspaces.length + 1}`;
    this.workspaces.push(id);
    return { id, info: { headSha: 'h' } };
  }
  async workspaceOp(id: string, op: unknown) {
    return { id, op };
  }
  async closeWorkspace(id: string) {
    this.workspaces = this.workspaces.filter((w) => w !== id);
  }
  async copyTreeFromWorkspace(h: { id: string }, workspaceId: string) {
    this.copies.push({ sandbox: h.id, workspace: workspaceId });
  }
}

function pool(hosts: AgentPoolHost[], opts: { version?: string; waitMs?: number; agingMs?: number; resizeWaitMs?: number } = {}) {
  const agents = new Map(hosts.map((h) => [h.name, new FakeAgent(h.name)]));
  const backend = new AgentPoolSandboxBackend({
    hosts,
    tokenFor: (h) => `token-${h}`,
    healthTtlMs: 0,
    waitMs: opts.waitMs ?? 0,
    ...(opts.agingMs !== undefined ? { agingMs: opts.agingMs } : {}),
    ...(opts.resizeWaitMs !== undefined ? { resizeWaitMs: opts.resizeWaitMs } : {}),
    ...(opts.version ? { version: opts.version } : {}),
    clientFor: (h) => agents.get(h.name)!,
  });
  return { backend, agents };
}

const A = { name: 'a', url: 'http://a:8790', slots: 2 };
const B = { name: 'b', url: 'http://b:8790', slots: 1 };

describe('AgentPoolSandboxBackend', () => {
  it('spreads sandboxes by load, routes calls by the host in the handle, and frees slots on destroy', async () => {
    const { backend, agents } = pool([A, B]);
    expect(backend.capacity).toBe(3);
    const h1 = await backend.create(spec);
    const h2 = await backend.create(spec);
    const h3 = await backend.create(spec);
    expect([h1, h2, h3].map((h) => backend.hostOf(h))).toEqual(['a', 'b', 'a']);
    expect(h2.containerId).toBe('b/rvb-b-1');
    expect((await backend.getArtifact(h2, '/x')).content).toBe('b');
    await expect(backend.create(spec)).rejects.toThrow(/no sandbox host had a free slot/);
    await backend.destroy(h2);
    expect(agents.get('b')!.destroyed).toEqual(['rvb-b-1']);
    expect(backend.hostOf(await backend.create(spec))).toBe('b');
  });

  it('skips full, unreachable, draining and other-version hosts', async () => {
    const { backend, agents } = pool([A, B], { version: 'v1' });
    agents.get('a')!.full = true;
    expect(backend.hostOf(await backend.create(spec))).toBe('b');

    const other = pool([A, B], { version: 'v1' });
    other.agents.get('a')!.down = true;
    other.agents.get('b')!.version = 'v0';
    await expect(other.backend.create(spec)).rejects.toThrow(/no sandbox host/);
    other.agents.get('a')!.down = false;
    other.agents.get('a')!.draining = true;
    await expect(other.backend.create(spec)).rejects.toThrow(/no sandbox host/);
    other.agents.get('a')!.draining = false;
    expect(other.backend.hostOf(await other.backend.create(spec))).toBe('a');
  });

  it('places by memory budget and disk slots, not just the sandbox count', async () => {
    const { backend, agents } = pool([{ name: 'a', url: 'http://a', slots: 8 }]);
    agents.get('a')!.maxMemoryMb = 6144;
    agents.get('a')!.scratchSlots = 2;
    const big = { ...spec, resources: { ...spec.resources, memoryMb: 4096 } };
    const disk = { ...spec, resources: { ...spec.resources, workspace: 'disk' as const } };
    await backend.create(big);
    await expect(backend.create(big)).rejects.toThrow(/free slot in time/);
    await backend.create(disk);
    await backend.create(disk);
    // Memory would fit (4096 + 3 × 512), but both disk slots are taken.
    await expect(backend.create(disk)).rejects.toThrow(/free slot in time/);
    await expect(backend.create(spec)).resolves.toBeDefined();
  });

  it('a released sandbox lets the next waiter in at once, highest priority first', async () => {
    const { backend } = pool([{ name: 'a', url: 'http://a', slots: 1 }], { waitMs: 5_000 });
    const first = await backend.create(spec);
    const order: string[] = [];
    const low = backend.create({ ...spec, priority: 10 }).then(() => order.push('validation'));
    const high = backend.create({ ...spec, priority: 30 }).then(() => order.push('review'));
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await backend.destroy(first);
    await high;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(order).toEqual(['review']);
    await backend.destroy({ id: 'rvb-a-2', containerId: 'a/rvb-a-2' });
    await low;
    expect(order).toEqual(['review', 'validation']);
  });

  it('a sandbox that waited long keeps its host: smaller ones stop passing it', async () => {
    const { backend, agents } = pool([{ name: 'a', url: 'http://a', slots: 8 }], { waitMs: 5_000, agingMs: 50 });
    agents.get('a')!.maxMemoryMb = 4096;
    const small = await backend.create(spec); // 512 in use
    const bigDone = backend.create({ ...spec, resources: { ...spec.resources, memoryMb: 4096 }, priority: 10 });
    // Before aging, a small one passes the big one that does not fit yet.
    await expect(backend.create(spec)).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 80));
    // Aged: the host is kept for the big one; a new small sandbox waits (and times out here).
    const smallLater = backend.create({ ...spec, priority: 30 });
    await new Promise((r) => setTimeout(r, 30));
    expect(agents.get('a')!.live.size).toBe(2);
    await backend.destroy(small);
    await backend.destroy({ id: 'rvb-a-2', containerId: 'a/rvb-a-2' });
    await expect(bigDone).resolves.toBeDefined();
    void smallLater.catch(() => undefined);
  });

  it('pins a sandbox to spec.placement and refuses unknown hosts', async () => {
    const { backend } = pool([A, B]);
    expect(backend.hostOf(await backend.create({ ...spec, placement: 'b' }))).toBe('b');
    await expect(backend.create({ ...spec, placement: 'b' })).rejects.toThrow(/sandbox host b had no free slot/);
    await expect(backend.create({ ...spec, placement: 'zz' })).rejects.toThrow(/unknown sandbox host/);
  });

  it('passes through request errors other than 503', async () => {
    const { backend, agents } = pool([A]);
    agents.get('a')!.create = async () => {
      throw new AgentRequestError(400, 'image not allowed');
    };
    await expect(backend.create(spec)).rejects.toThrow(/image not allowed/);
  });

  it('sweeps every host and tolerates one being down', async () => {
    const { backend, agents } = pool([A, B]);
    agents.get('b')!.down = true;
    expect(await backend.sweepOrphans(1000)).toBe(1);
  });

  it('parses SANDBOX_AGENTS', () => {
    expect(parseAgentHosts('sandbox-1=http://100.1.2.3:8790=8, hel=http://100.4.5.6:8790=4')).toEqual([
      { name: 'sandbox-1', url: 'http://100.1.2.3:8790', slots: 8 },
      { name: 'hel', url: 'http://100.4.5.6:8790', slots: 4 },
    ]);
    expect(() => parseAgentHosts('sandbox-1=100.1.2.3=8')).toThrow(/name=url=slots/);
  });

  it('opens a workspace on a usable host; its sandboxes copy from it on the same host only', async () => {
    const { backend, agents } = pool([A, B]);
    agents.get('a')!.full = true;
    const ws = await backend.openWorkspace({ cloneUrl: 'https://x' });
    expect(ws.host).toBe('b');
    expect(await ws.op({ op: 'readFiles' })).toEqual({ id: 'ws-b-1', op: { op: 'readFiles' } });
    const onB = await backend.create({ ...spec, placement: ws.host });
    await backend.copyFromWorkspace(onB, { host: ws.host, workspaceId: ws.id }, '/workspace/worktree');
    expect(agents.get('b')!.copies).toEqual([{ sandbox: onB.id, workspace: 'ws-b-1' }]);
    agents.get('a')!.full = false;
    const onA = await backend.create({ ...spec, placement: 'a' });
    await expect(backend.copyFromWorkspace(onA, { host: 'b', workspaceId: ws.id }, '/workspace/worktree')).rejects.toThrow(
      /cannot read a workspace on b/,
    );
    await ws.close();
    expect(agents.get('b')!.workspaces).toEqual([]);
  });

  it('growing a sandbox waits for room on its host; shrinking gives room back at once', async () => {
    const { backend, agents } = pool([{ ...A, slots: 4 }], { waitMs: 5_000, resizeWaitMs: 5_000 });
    const a = agents.get('a')!;
    a.maxMemoryMb = 3072;
    const big = await backend.create({ ...spec, resources: { ...spec.resources, memoryMb: 1024 } });
    const other = await backend.create({ ...spec, resources: { ...spec.resources, memoryMb: 1536 } });
    // 1024 + 1536 of 3072: growing `big` to 2048 needs 1024 more; only 512 is free.
    let grown = false;
    const growing = backend.resize(big, { memoryMb: 2048 }).then((u) => {
      grown = true;
      return u;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(grown).toBe(false);
    // Shrinking the other one frees 1024: the resize goes through.
    expect((await backend.resize(other, { memoryMb: 512 })).memoryMb).toBe(512);
    expect((await growing).memoryMb).toBe(2048);
    expect(a.resizes).toEqual([{ memoryMb: 512 }, { memoryMb: 2048 }]);
  });

  it('a resize that finds no room in time fails, and leaves the sandbox as it was', async () => {
    const { backend, agents } = pool([A], { resizeWaitMs: 0 });
    agents.get('a')!.maxMemoryMb = 1024;
    const h = await backend.create(spec);
    await expect(backend.resize(h, { memoryMb: 2048 })).rejects.toThrow(/no room to grow the sandbox in time/);
    expect((await backend.usage(h)).memoryMb).toBe(512);
  });

  it('places disk sandboxes by the disk the host can still grant, and grows disk the same way', async () => {
    const { backend, agents } = pool([{ ...A, slots: 4 }], { waitMs: 0, resizeWaitMs: 0 });
    const a = agents.get('a')!;
    a.scratchSlots = 4;
    a.scratchPoolMb = 10_000;
    const disk = (diskMb: number): SandboxSpec => ({ ...spec, resources: { ...spec.resources, workspace: 'disk', diskMb } });
    const h = await backend.create(disk(6000));
    await expect(backend.create(disk(5000))).rejects.toThrow(/no sandbox host had a free slot/);
    await backend.create(disk(4000));
    await expect(backend.resize(h, { diskMb: 7000 })).rejects.toThrow(/no room to grow/);
  });
});
