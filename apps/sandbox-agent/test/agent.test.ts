import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AgentRequestError,
  HttpSandboxBackend,
  type ExecRequest,
  type ExecResult,
  type SandboxResize,
  type SandboxSpec,
  type SandboxUsage,
} from '@reviewbot/sandbox';
import type { AgentRuntime } from '../src/runtime.js';
import { buildAgent } from '../src/server.js';
import { parseWorkspaceRequest, type WorkspaceStore } from '../src/workspaces.js';

const TOKEN = 'test-token';
const IMAGE = 'ghcr.io/example/reviewbot:sha-1';
const ID = 'rvb-0192f0c4-7b7a-7cc3-9c11-123456789abc';

const spec: SandboxSpec = {
  image: IMAGE,
  network: { mode: 'allowlist', hosts: [] },
  resources: { cpus: 1, memoryMb: 512, pids: 64, diskMb: 64 },
};

const execReq: ExecRequest = {
  argv: ['node', 'x.mjs'],
  purpose: 'confirm',
  timeoutMs: 60_000,
  maxOutputBytes: 1000,
};

function result(stdout: string): ExecResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 1,
    evidence: {
      image: IMAGE,
      runtime: 'runc',
      argv: execReq.argv,
      purpose: 'confirm',
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
    },
  };
}

class FakeRuntime implements AgentRuntime {
  files = new Map<string, string>();
  owners: (string | undefined)[] = [];
  tars: Buffer[] = [];
  destroyed: string[] = [];
  execDelayMs = 0;
  execCalls = 0;
  binds: (readonly { src: string; dst: string }[] | undefined)[] = [];
  async create(_spec: SandboxSpec, owner: string | undefined, binds?: readonly { src: string; dst: string }[]) {
    this.owners.push(owner);
    this.binds.push(binds);
    return { id: ID, containerId: 'c1' };
  }
  async exec(_id: string, req: ExecRequest) {
    this.execCalls++;
    await new Promise((r) => setTimeout(r, this.execDelayMs));
    return result(req.argv.join(' '));
  }
  async putFile(_id: string, req: { path: string; content: string }) {
    this.files.set(req.path, req.content);
  }
  async getArtifact(_id: string, path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error('no such file');
    return { path, content, bytes: Buffer.byteLength(content) };
  }
  async extractTar(_id: string, tar: Readable) {
    const chunks: Buffer[] = [];
    for await (const c of tar) chunks.push(c as Buffer);
    this.tars.push(Buffer.concat(chunks));
  }
  async destroy(id: string) {
    this.destroyed.push(id);
  }
  async sweep() {
    return 3;
  }
  async count() {
    return 1;
  }
  async memoryMb() {
    return 512;
  }
  limits = { cpus: 1, memoryMb: 512, swapMb: 0 };
  resizes: SandboxResize[] = [];
  async resize(_id: string, req: SandboxResize): Promise<SandboxUsage> {
    this.resizes.push(req);
    this.limits = { cpus: req.cpus ?? this.limits.cpus, memoryMb: req.memoryMb ?? this.limits.memoryMb, swapMb: req.swapMb ?? this.limits.swapMb };
    return this.usage();
  }
  async usage(): Promise<SandboxUsage> {
    return { ...this.limits, memoryUsedMb: 100, memoryPeakMb: 300, oomKills: 0 };
  }
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(
  runtime: FakeRuntime,
  pingMs = 50,
  extra: {
    maxSandboxes?: number;
    draining?: () => boolean;
    metricsTokenSha256?: string;
    workspaces?: WorkspaceStore;
    maxWorkspaces?: number;
    workspaceHostRoot?: { container: string; host: string };
  } = {},
) {
  app = await buildAgent({
    ...extra,
    runtime,
    tokenSha256: createHash('sha256').update(TOKEN).digest('hex'),
    allowedImages: new Set([IMAGE]),
    version: 'v-test',
    quiet: true,
    pingMs,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

describe('sandbox-agent over HttpSandboxBackend', () => {
  it('refuses a create beyond maxSandboxes, and every create while draining, with 503', async () => {
    const runtime = new (class extends FakeRuntime {
      running = 0;
      override async create(sp: SandboxSpec, owner: string | undefined) {
        this.running++;
        return super.create(sp, owner);
      }
      override async destroy(id: string) {
        this.running--;
        return super.destroy(id);
      }
      override async count() {
        return this.running;
      }
    })();
    let draining = false;
    const url = await start(runtime, 50, { maxSandboxes: 2, draining: () => draining });
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN });
    const first = await backend.create(spec);
    await backend.create(spec);
    await expect(backend.create(spec)).rejects.toMatchObject({ status: 503 });
    expect(await backend.health()).toMatchObject({ sandboxes: 2, maxSandboxes: 2 });
    await backend.destroy(first);
    await expect(backend.create(spec)).resolves.toMatchObject({ id: ID });
    draining = true;
    await expect(backend.create(spec)).rejects.toMatchObject({ status: 503 });
    expect(await backend.health()).toMatchObject({ draining: true });
  });

  it('refuses a create that does not fit the memory budget, counting creates in flight', async () => {
    const runtime = new (class extends FakeRuntime {
      memory = new Map<string, number>();
      n = 0;
      override async create(sp: SandboxSpec, owner: string | undefined) {
        const h = await super.create(sp, owner);
        this.memory.set(`${h.id}-${this.n++}`, sp.resources.memoryMb);
        return h;
      }
      override async destroy(id: string) {
        const [first] = this.memory.keys();
        if (first) this.memory.delete(first);
        return super.destroy(id);
      }
      override async memoryMb() {
        return [...this.memory.values()].reduce((a, b) => a + b, 0);
      }
    })();
    const url = await start(runtime, 50, { maxSandboxes: 8, maxMemoryMb: 6144 });
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN });
    const big = { ...spec, resources: { ...spec.resources, memoryMb: 4096 } };
    const small = { ...spec, resources: { ...spec.resources, memoryMb: 512 } };
    const validation = await backend.create(big);
    // A second validation would need 8 GiB: it waits (503) while the first runs.
    await expect(backend.create(big)).rejects.toMatchObject({ status: 503 });
    for (let i = 0; i < 4; i++) await backend.create(small);
    await expect(backend.create(small)).rejects.toMatchObject({ status: 503 });
    await backend.destroy(validation);
    await expect(backend.create(small)).resolves.toMatchObject({ id: ID });
  });

  it('grows a sandbox only within the memory budget; shrinks and reports usage', async () => {
    const runtime = new (class extends FakeRuntime {
      override async memoryMb() {
        return this.limits.memoryMb + 4096; // this sandbox + another one of 4 GiB
      }
    })();
    const url = await start(runtime, 50, { maxSandboxes: 8, maxMemoryMb: 6144 });
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN });
    const h = { id: ID, containerId: 'c1' };
    // 512 + 4096 + 2048 more > 6144.
    await expect(backend.resize(h, { memoryMb: 2560 })).rejects.toMatchObject({ status: 503 });
    expect(await backend.resize(h, { memoryMb: 2048, swapMb: 1024 })).toMatchObject({ memoryMb: 2048, swapMb: 1024 });
    expect(await backend.resize(h, { memoryMb: 1024, stopProcesses: true })).toMatchObject({ memoryMb: 1024 });
    expect(runtime.resizes.at(-1)).toEqual({ memoryMb: 1024, stopProcesses: true });
    await expect(backend.resize(h, { memoryMb: -1 })).rejects.toMatchObject({ status: 400 });
    expect(await backend.usage(h)).toMatchObject({ memoryPeakMb: 300, memoryUsedMb: 100 });
  });

  it('a disk grow without room is a 503 (the pool waits), and health reports the disk left', async () => {
    const runtime = new (class extends FakeRuntime {
      override async resize(): Promise<SandboxUsage> {
        throw Object.assign(new Error('no free scratch slot or disk on this host'), { code: 'capacity_exhausted' });
      }
      async scratchStatus() {
        return { freeMb: 1234, hostFreeMb: 50_000 };
      }
      scratchFree() {
        return 3;
      }
    })();
    const url = await start(runtime, 50, { maxSandboxes: 8 });
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN });
    await expect(backend.resize({ id: ID, containerId: 'c1' }, { diskMb: 9000 })).rejects.toMatchObject({ status: 503 });
    expect(await backend.health()).toMatchObject({ scratchFree: 3, scratchFreeMb: 1234 });
  });

  it('refuses a disk sandbox while no scratch slot is free; memory sandboxes still fit', async () => {
    const runtime = new (class extends FakeRuntime {
      scratchFree() {
        return 0;
      }
    })();
    const url = await start(runtime, 50, { maxSandboxes: 8 });
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN });
    const disk = { ...spec, resources: { ...spec.resources, workspace: 'disk' as const } };
    await expect(backend.create(disk)).rejects.toMatchObject({ status: 503 });
    await expect(backend.create({ ...spec, resources: { ...spec.resources, workspace: 'memory' } })).resolves.toMatchObject({ id: ID });
  });

  it('serves /metrics only with the scrape token', async () => {
    const url = await start(new FakeRuntime(), 50, {
      maxSandboxes: 4,
      metricsTokenSha256: createHash('sha256').update('scrape').digest('hex'),
    });
    const get = (token: string) => fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${token}` } });
    expect((await get(TOKEN)).status).toBe(401);
    const res = await get('scrape');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('winnowl_agent_sandboxes 1');
    expect(body).toContain('winnowl_agent_max_sandboxes 4');
    expect(body).toContain('winnowl_agent_failures_total{kind="sandbox_create"} 0');
    // The scrape token opens nothing else.
    expect((await fetch(`${url}/v1/health`, { headers: { authorization: 'Bearer scrape' } })).status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const url = await start(new FakeRuntime());
    const backend = new HttpSandboxBackend({ baseUrl: url, token: 'nope' });
    await expect(backend.health()).rejects.toMatchObject({ status: 401 });
  });

  it('round-trips create/exec/files/destroy and passes the owner', async () => {
    const runtime = new FakeRuntime();
    const url = await start(runtime);
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN, ownerId: 'worker-1' });

    expect(await backend.health()).toEqual({ version: 'v-test', sandboxes: 1 });
    const handle = await backend.create(spec);
    expect(handle).toEqual({ id: ID, containerId: 'c1' });
    expect(runtime.owners).toEqual(['worker-1']);

    runtime.execDelayMs = 200; // spans several 50 ms pings
    const r = await backend.exec(handle, execReq);
    expect(r.stdout).toBe('node x.mjs');

    await backend.putFile(handle, { path: '/workspace/input.json', content: '{"a":"ü"}' });
    expect((await backend.getArtifact(handle, '/workspace/input.json')).content).toBe('{"a":"ü"}');
    await expect(backend.getArtifact(handle, '/workspace/missing')).rejects.toBeInstanceOf(
      AgentRequestError,
    );

    expect(await backend.sweepOrphans(1000, new Set(['worker-1']))).toBe(3);
    await backend.destroy(handle);
    expect(runtime.destroyed).toEqual([ID]);
  });

  it('re-attaches to a running exec after the stream goes silent', async () => {
    const runtime = new FakeRuntime();
    runtime.execDelayMs = 700;
    // Agent pings far apart; the client watchdog (200 ms) drops the stream mid-exec.
    const url = await start(runtime, 10_000);
    const logs: string[] = [];
    const backend = new HttpSandboxBackend({
      baseUrl: url,
      token: TOKEN,
      heartbeatTimeoutMs: 200,
      log: (m) => logs.push(m),
    });
    const r = await backend.exec({ id: ID, containerId: 'c1' }, execReq);
    expect(r.stdout).toBe('node x.mjs');
    expect(runtime.execCalls).toBe(1); // re-attached, never re-run
    expect(logs.some((m) => m.includes('re-attaching'))).toBe(true);
  });

  it('refuses images outside the allowlist and full networking', async () => {
    const url = await start(new FakeRuntime());
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN });
    await expect(backend.create({ ...spec, image: 'alpine:3.24' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      backend.create({ ...spec, network: { mode: 'full', adminApproved: true } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('streams a directory as tar into the sandbox and checks the destination', async () => {
    const runtime = new FakeRuntime();
    const url = await start(runtime);
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN });
    const dir = mkdtempSync(join(tmpdir(), 'agent-tar-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');

    await backend.copyInto({ id: ID, containerId: 'c1' }, dir, '/workspace/worktree');
    const tarFile = join(dir, '..', `${Date.now()}-out.tar`);
    writeFileSync(tarFile, runtime.tars[0]!);
    expect(execFileSync('tar', ['-tf', tarFile], { encoding: 'utf8' })).toContain('./src/a.ts');

    await expect(
      backend.copyInto({ id: ID, containerId: 'c1' }, dir, '/etc'),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('does not retry an unknown sandbox id', async () => {
    const url = await start(new FakeRuntime());
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN });
    await expect(backend.exec({ id: 'not-ours', containerId: 'x' }, execReq)).rejects.toMatchObject(
      { status: 404 },
    );
  });
});

describe('sandbox-agent workspaces', () => {
  const WS = 'ws-0192f0c4-7b7a-7cc3-9c11-123456789abc';

  /** Records calls; the head worktree is a real directory so tree copies can be checked. */
  class FakeStore implements WorkspaceStore {
    opened: unknown[] = [];
    ops: unknown[] = [];
    closed: string[] = [];
    constructor(readonly head: string) {}
    async open(request: unknown) {
      this.opened.push(request);
      return { id: WS, info: { headSha: 'a'.repeat(40) } as never };
    }
    async op(id: string, req: unknown) {
      this.ops.push(req);
      if (id !== WS) throw new Error('unknown');
      return { 'app.py': 'x' };
    }
    headDir(id: string) {
      return id === WS ? this.head : undefined;
    }
    async close(id: string) {
      this.closed.push(id);
    }
    async sweep() {
      return 2;
    }
    count() {
      return this.opened.length - this.closed.length;
    }
  }

  it('validates workspace requests: only https clone sources, well-formed shas and refs', () => {
    const ok = { cloneUrl: 'https://x-access-token:t@github.com/o/r.git', headSha: 'a'.repeat(40), headRef: 'refs/pull/7/head' };
    expect(parseWorkspaceRequest(ok)).toEqual(ok);
    // file:// or a bare path would clone this host's own files.
    expect(parseWorkspaceRequest({ cloneUrl: 'file:///etc' })).toMatch(/https/);
    expect(parseWorkspaceRequest({ cloneUrl: '/var/lib/winnowl' })).toMatch(/https/);
    expect(parseWorkspaceRequest({ ...ok, headSha: 'HEAD' })).toMatch(/headSha/);
    expect(parseWorkspaceRequest({ ...ok, headRef: 'refs/../../x' })).toMatch(/headRef/);
    expect(parseWorkspaceRequest({ ...ok, stackRootBranch: '--upload-pack=x' })).toMatch(/stackRootBranch/);
    expect(parseWorkspaceRequest({ ...ok, depth: 0 })).toMatch(/depth/);
  });

  it('mounts a workspace of this host read-only, from its host path; refuses others and paths outside /workspace', async () => {
    const store = new FakeStore('/var/lib/winnowl/workspaces/ws-x/head');
    const runtime = new FakeRuntime();
    const url = await start(runtime, 50, {
      workspaces: store,
      workspaceHostRoot: { container: '/var/lib/winnowl/workspaces', host: '/srv/winnowl-scratch/workspaces' },
    });
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN });
    await backend.create({ ...spec, mountWorkspace: { workspaceId: WS, dest: '/workspace/worktree' } });
    expect(runtime.binds.at(-1)).toEqual([{ src: '/srv/winnowl-scratch/workspaces/ws-x/head', dst: '/workspace/worktree' }]);
    const bad = (m: { workspaceId: string; dest: string }) => backend.create({ ...spec, mountWorkspace: m });
    await expect(bad({ workspaceId: 'ws-' + '0'.repeat(36), dest: '/workspace/t' })).rejects.toMatchObject({ status: 404 });
    await expect(bad({ workspaceId: WS, dest: '/etc' })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ workspaceId: WS, dest: '/workspace/../etc' })).rejects.toMatchObject({ status: 400 });
    // An agent that does not know its host path cannot mount.
    await app?.close();
    const plain = await start(new FakeRuntime(), 50, { workspaces: store });
    await expect(
      new HttpSandboxBackend({ baseUrl: plain, token: TOKEN }).create({ ...spec, mountWorkspace: { workspaceId: WS, dest: '/workspace/t' } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('opens, serves, copies into a sandbox on this host, and closes a workspace', async () => {
    const head = mkdtempSync(join(tmpdir(), 'agent-ws-'));
    writeFileSync(join(head, 'app.py'), 'print(1)\n');
    const store = new FakeStore(head);
    const runtime = new FakeRuntime();
    const url = await start(runtime, 50, { workspaces: store, maxWorkspaces: 1 });
    const backend = new HttpSandboxBackend({ baseUrl: url, token: TOKEN, ownerId: 'w1' });

    const opened = await backend.openWorkspace({ cloneUrl: 'https://github.com/o/r.git', headSha: 'a'.repeat(40) });
    expect(opened.id).toBe(WS);
    expect(store.opened).toHaveLength(1);
    // Full: the second open is refused so the pool tries another host.
    await expect(backend.openWorkspace({ cloneUrl: 'https://github.com/o/r.git' })).rejects.toMatchObject({ status: 503 });
    await expect(backend.openWorkspace({ cloneUrl: 'file:///etc' })).rejects.toMatchObject({ status: 400 });

    expect(await backend.workspaceOp(WS, { op: 'readFiles', paths: ['app.py'] })).toEqual({ 'app.py': 'x' });
    await expect(backend.workspaceOp('ws-nope', { op: 'readFiles', paths: [] })).rejects.toMatchObject({ status: 404 });

    await backend.copyTreeFromWorkspace({ id: ID, containerId: 'c1' }, WS, '/workspace/worktree');
    const tarFile = join(head, '..', `${Date.now()}-ws.tar`);
    writeFileSync(tarFile, runtime.tars[0]!);
    expect(execFileSync('tar', ['-tf', tarFile], { encoding: 'utf8' })).toContain('./app.py');
    await expect(backend.copyTreeFromWorkspace({ id: ID, containerId: 'c1' }, WS, '/etc')).rejects.toMatchObject({ status: 400 });

    expect(await backend.health()).toMatchObject({ workspaces: 1 });
    await backend.closeWorkspace(WS);
    expect(store.closed).toEqual([WS]);
    // The sweep covers workspaces too.
    expect(await backend.sweepOrphans(1000, new Set(['w1']))).toBe(5);
  });
});
