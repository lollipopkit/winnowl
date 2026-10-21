import type { Readable } from 'node:stream';
import {
  DockerSandboxBackend,
  runProcess,
  SCRATCH_SLOT_LABEL,
  type ArtifactContent,
  type DockerBackendOptions,
  type ExecRequest,
  type ExecResult,
  type PutFileRequest,
  type SandboxHandle,
  type SandboxResize,
  type SandboxSpec,
  type SandboxUsage,
} from '@reviewbot/sandbox';

/** Local sandbox operations keyed by sandbox id (the container name). */
export interface AgentRuntime {
  /** `readonlyBinds`: host directories (resolved by the agent itself) mounted read-only. */
  create(
    spec: SandboxSpec,
    owner: string | undefined,
    readonlyBinds?: readonly { src: string; dst: string }[],
  ): Promise<SandboxHandle>;
  exec(id: string, req: ExecRequest): Promise<ExecResult>;
  putFile(id: string, req: PutFileRequest): Promise<void>;
  getArtifact(id: string, path: string): Promise<ArtifactContent>;
  extractTar(id: string, tar: Readable, dest: string): Promise<void>;
  destroy(id: string): Promise<void>;
  sweep(olderThanMs: number, liveOwners: ReadonlySet<string> | undefined): Promise<number>;
  /** Running sandbox containers; the autoscaler's ground truth for "in use". */
  count(): Promise<number>;
  /** Free disk-quota slots; undefined when the host has none (a disk sandbox then needs none). */
  scratchFree?(): number | undefined;
  /** MiB a slot can still get and free host disk under the scratch image; undefined without slots. */
  scratchStatus?(): Promise<{ freeMb: number; hostFreeMb: number } | undefined>;
  resize(id: string, req: SandboxResize): Promise<SandboxUsage>;
  usage(id: string): Promise<SandboxUsage>;
  memoryMb(): Promise<number>;
}

/** One backend per owner so every container carries its creator's owner label for the orphan sweep. */
export class DockerAgentRuntime implements AgentRuntime {
  private readonly byOwner = new Map<string, DockerSandboxBackend>();
  private readonly handles = new Map<
    string,
    { handle: SandboxHandle; backend: DockerSandboxBackend }
  >();
  private readonly base: DockerSandboxBackend;

  constructor(private readonly shared: Pick<DockerBackendOptions, 'egressNetwork' | 'registryNetwork' | 'scratch'>) {
    this.base = new DockerSandboxBackend({ ...shared });
  }

  /** After a restart, slots held by still-running sandboxes are not free. */
  async adoptScratchSlots(): Promise<void> {
    if (!this.shared.scratch) return;
    const r = await runProcess(
      'docker',
      ['ps', '--filter', `label=${SCRATCH_SLOT_LABEL}`, '--format', `{{.Names}}\t{{.Label "${SCRATCH_SLOT_LABEL}"}}`],
      { timeoutMs: 15_000 },
    );
    if (r.code !== 0) throw new Error(`docker ps failed: ${r.stderr.trim()}`);
    for (const line of r.stdout.split('\n')) {
      const [name, slot] = line.trim().split('\t');
      if (name && slot && /^\d+$/.test(slot)) await this.shared.scratch.adopt(Number(slot), name);
    }
  }

  scratchFree(): number | undefined {
    return this.shared.scratch?.free();
  }

  async scratchStatus(): Promise<{ freeMb: number; hostFreeMb: number } | undefined> {
    const scratch = this.shared.scratch;
    if (!scratch) return undefined;
    await scratch.refresh();
    return { freeMb: scratch.freeMb(), hostFreeMb: scratch.hostFreeMb() ?? 0 };
  }

  resize(id: string, req: SandboxResize): Promise<SandboxUsage> {
    const { handle, backend } = this.lookup(id);
    return backend.resize(handle, req);
  }

  usage(id: string): Promise<SandboxUsage> {
    const { handle, backend } = this.lookup(id);
    return backend.usage(handle);
  }

  async create(
    spec: SandboxSpec,
    owner: string | undefined,
    readonlyBinds: readonly { src: string; dst: string }[] = [],
  ): Promise<SandboxHandle> {
    const backend = owner ? this.backendFor(owner) : this.base;
    const handle = await backend.create(spec, { readonlyBinds });
    this.handles.set(handle.id, { handle, backend });
    return handle;
  }

  exec(id: string, req: ExecRequest): Promise<ExecResult> {
    const { handle, backend } = this.lookup(id);
    return backend.exec(handle, req);
  }

  putFile(id: string, req: PutFileRequest): Promise<void> {
    const { handle, backend } = this.lookup(id);
    return backend.putFile(handle, req);
  }

  getArtifact(id: string, path: string): Promise<ArtifactContent> {
    const { handle, backend } = this.lookup(id);
    return backend.getArtifact(handle, path);
  }

  extractTar(id: string, tar: Readable, dest: string): Promise<void> {
    const { handle, backend } = this.lookup(id);
    return backend.extractTarInto(handle, tar, dest);
  }

  async destroy(id: string): Promise<void> {
    const { handle, backend } = this.lookup(id);
    try {
      await backend.destroy(handle);
    } finally {
      this.handles.delete(id);
    }
  }

  async sweep(olderThanMs: number, liveOwners: ReadonlySet<string> | undefined): Promise<number> {
    const removed = await this.base.sweepOrphans(olderThanMs, liveOwners);
    await this.forgetGone();
    return removed;
  }

  async count(): Promise<number> {
    return (await this.runningNames()).size;
  }

  // Unknown ids (e.g. after a restart) still resolve: operations address the container by name,
  // which the HTTP layer has already validated.
  private lookup(id: string): { handle: SandboxHandle; backend: DockerSandboxBackend } {
    return this.handles.get(id) ?? { handle: { id, containerId: id }, backend: this.base };
  }

  private backendFor(owner: string): DockerSandboxBackend {
    let backend = this.byOwner.get(owner);
    if (!backend) {
      backend = new DockerSandboxBackend({ ...this.shared, ownerId: owner });
      this.byOwner.set(owner, backend);
    }
    return backend;
  }

  async memoryMb(): Promise<number> {
    const names = [...(await this.runningNames())];
    if (names.length === 0) return 0;
    const r = await runProcess('docker', ['inspect', '--format', '{{.HostConfig.Memory}}', ...names], {
      timeoutMs: 15_000,
    });
    // A container that exited between `ps` and `inspect` is missing from the output, not an error.
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(`docker inspect failed: ${r.stderr.trim()}`);
    const bytes = r.stdout
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .reduce((a, b) => a + b, 0);
    return Math.ceil(bytes / (1024 * 1024));
  }

  private async forgetGone(): Promise<void> {
    const running = await this.runningNames();
    for (const id of this.handles.keys()) if (!running.has(id)) this.handles.delete(id);
    this.shared.scratch?.reconcile(running);
  }

  private async runningNames(): Promise<Set<string>> {
    const r = await runProcess(
      'docker',
      ['ps', '--filter', 'label=winnowl.sandbox=review', '--format', '{{.Names}}'],
      { timeoutMs: 15_000 },
    );
    if (r.code !== 0) throw new Error(`docker ps failed: ${r.stderr.trim()}`);
    return new Set(
      r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
  }
}
