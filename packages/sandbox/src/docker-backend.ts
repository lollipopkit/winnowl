import { Transform, type Readable } from 'node:stream';
import { uuidv7 } from '@reviewbot/ids';
import { runProcess, runProcessFromStream, tarDirectory } from './exec.js';
import { dockerNetworkArgs, type SandboxNetworks } from './network.js';
import { DEFAULT_SCRATCH_MB } from './types.js';
import type { ScratchSlotPool } from './scratch-slots.js';
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

/** Ownership label; orphan sweeps only touch containers carrying it. */
const SANDBOX_LABEL = 'winnowl.sandbox';

/** Container name prefix; also identifies leftovers from before the label existed. */
const NAME_PREFIX = 'rvb-';

/**
 * The runner process that created the sandbox, so a dead process's leftovers can be told apart
 * from a live runner's sandboxes (abandoned sandboxes keep spending LLM quota until removed).
 */
const OWNER_LABEL = 'winnowl.owner';
/** The scratch slot a sandbox holds (`ScratchSlotPool`), so a restarted agent knows which are taken. */
export const SCRATCH_SLOT_LABEL = 'winnowl.scratch-slot';
const RESERVED_LABELS = new Set([SANDBOX_LABEL, OWNER_LABEL, SCRATCH_SLOT_LABEL]);
/** nobody. */
const DEFAULT_RUN_AS_USER = 65534;

/**
 * `--rm` matters: the container runs `sleep <lifetime>` and must not linger as Exited when the
 * control plane is SIGKILLed before destroy runs.
 */
export function dockerCreateArgs(
  name: string,
  spec: SandboxSpec,
  networks: SandboxNetworks,
  runAsUser: number = DEFAULT_RUN_AS_USER,
  /** Creator's worker id (OWNER_LABEL). Reserved labels in `spec.labels` are dropped, so it comes here. */
  ownerId?: string,
  /** A disk-quota slot (`ScratchSlotPool`) for `/workspace` and, when the sandbox runs builds, `/tmp`. */
  scratch?: { slot: number; dir: string },
  /** Host directories mounted read-only (a workspace's tree; resolved by the agent, never by callers). */
  readonlyBinds: readonly { src: string; dst: string }[] = [],
): string[] {
  const lifetime = spec.maxLifetimeSeconds ?? 3600;
  // docker's tmpfs default is noexec; said explicitly either way.
  const execOpt = spec.writableExec ? 'exec' : 'noexec';
  const envArgs = Object.entries(spec.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const labelArgs = Object.entries(spec.labels ?? {})
    .filter(([key]) => !RESERVED_LABELS.has(key))
    .flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  return [
    'create',
    '--rm',
    '--name',
    name,
    '--label',
    `${SANDBOX_LABEL}=review`,
    ...(ownerId ? ['--label', `${OWNER_LABEL}=${ownerId}`] : []),
    ...(scratch ? ['--label', `${SCRATCH_SLOT_LABEL}=${scratch.slot}`] : []),
    '--user',
    `${runAsUser}:${runAsUser}`,
    // A real init reaps orphaned processes; otherwise each one stays a zombie holding a pid.
    '--init',
    ...dockerNetworkArgs(spec.network, networks),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(spec.resources.pids),
    '--memory',
    `${spec.resources.memoryMb}m`,
    // Swap only when the spec asks for it.
    '--memory-swap',
    `${spec.resources.memoryMb + (spec.resources.swapMb ?? 0)}m`,
    '--cpus',
    String(spec.resources.cpus),
    '--read-only',
    // disk: the scratch slot (xfs quota) if any; else an anonymous volume without quota (local development).
    ...(spec.resources.workspace === 'disk'
      ? scratch
        ? ['--mount', `type=bind,src=${scratch.dir}/w,dst=/workspace`]
        : ['--mount', 'type=volume,dst=/workspace']
      : ['--tmpfs', `/workspace:rw,${execOpt},size=${spec.resources.diskMb}m,mode=1777`]),
    ...readonlyBinds.flatMap((b) => ['--mount', `type=bind,src=${b.src},dst=${b.dst},readonly`]),
    // Sandboxes that run builds keep their caches in the slot too; the rest get a small noexec tmpfs.
    ...(scratch && spec.writableExec
      ? ['--mount', `type=bind,src=${scratch.dir}/t,dst=/tmp`]
      : ['--tmpfs', `/tmp:rw,${execOpt},size=${spec.resources.scratchMb ?? DEFAULT_SCRATCH_MB}m,mode=1777`]),
    '--workdir',
    '/workspace',
    ...(spec.runtime ? ['--runtime', spec.runtime] : []),
    ...envArgs,
    ...labelArgs,
    spec.image,
    'sleep',
    String(lifetime),
  ];
}

/**
 * Passes bytes through until `max`; past it, ends the output (tar then fails on the truncated
 * archive, and `exceeded` turns that into a clear error) and drops the rest, so the upstream keeps
 * draining instead of erroring with a write after end.
 */
export function byteLimit(max: number): Transform & { exceeded?: boolean } {
  let seen = 0;
  const t: Transform & { exceeded?: boolean } = new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      if (t.exceeded) return done();
      if (seen > max) {
        t.exceeded = true;
        t.push(null);
        return done();
      }
      done(null, chunk);
    },
  });
  return t;
}

/** Directory size in MiB, rounded up. */
export async function directorySizeMb(dir: string): Promise<number> {
  const r = await runProcess('du', ['-sk', dir], { timeoutMs: 120_000 });
  const kb = Number(r.stdout.trim().split(/\s+/)[0]);
  if (r.code !== 0 || !Number.isFinite(kb)) throw new Error(`du ${dir} 失败: ${r.stderr.trim()}`);
  return Math.ceil(kb / 1024);
}

/** What the sandbox's cgroup says (`memory.stat`, `memory.events`, read from inside the container). */
export interface CgroupSample {
  /** anon + shmem: memory that cannot be reclaimed (page cache excluded). MiB. */
  usedMb: number;
  oomKills: number;
}

export function parseCgroupSample(text: string): CgroupSample {
  let anon = 0;
  let shmem = 0;
  let oomKills = 0;
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    if (key === 'anon') anon = n;
    else if (key === 'shmem') shmem = n;
    else if (key === 'oom_kill') oomKills = n;
  }
  return { usedMb: Math.ceil((anon + shmem) / (1024 * 1024)), oomKills };
}

/**
 * Kills every process in the sandbox except init (PID 1) and the sandbox's own `sleep` (init's
 * first child: started with the container, before any command could run) and itself. A few passes:
 * a process may fork while the first one runs. Init reaps them.
 */
const STOP_PROCESSES = [
  'main=$(tr " " "\\n" </proc/1/task/1/children | grep . | sort -n | head -1)',
  'for i in 1 2 3; do for p in /proc/[0-9]*; do n=${p#/proc/}; [ "$n" = 1 ] || [ "$n" = "$main" ] || [ "$n" = $$ ] || kill -9 "$n" 2>/dev/null; done; done',
  'true',
].join('\n');

/** How often memory is sampled while a command runs. */
const SAMPLE_MS = 2_000;

/** An exit 137 can be either our timeout kill or a cgroup OOM kill; only the former is a timeout. */
export function dockerExecTimedOut(input: {
  code: number | null;
  processTimedOut: boolean;
  durationMs: number;
  timeoutMs: number;
  oomKilled: boolean;
}): boolean {
  if (input.processTimedOut) return true;
  /*
   * Inside the container the command runs under `timeout -s KILL`, which reports 137 (128 + SIGKILL).
   * 124 and 143 are not ours: GNU timeout's "timed out" convention does not apply to a KILL, and
   * 143 is the command itself dying of SIGTERM — the user's own process, not our deadline.
   */
  if (input.code !== 137 || input.oomKilled) return false;
  // A near-deadline kill is the watchdog; an early 137 is the command killing itself.
  return input.durationMs >= input.timeoutMs * 0.95;
}

/** Upper bound: 95 min stage wall clock + 5 min wrap-up for review-in-sandbox. */
export const MAX_SANDBOX_LIFETIME_MS = 100 * 60_000;

/**
 * Age cutoff for unowned containers. Derived from {@link MAX_SANDBOX_LIFETIME_MS} and strictly
 * greater: any smaller cutoff would remove live sandboxes.
 */
export const ORPHAN_AGE_CUTOFF_MS = MAX_SANDBOX_LIFETIME_MS + 20 * 60_000;

export function assertOrphanAgeCutoff(olderThanMs: number): void {
  if (olderThanMs <= MAX_SANDBOX_LIFETIME_MS) {
    throw new Error(
      `orphan age cutoff ${olderThanMs}ms must exceed the maximum sandbox lifetime (${MAX_SANDBOX_LIFETIME_MS}ms)`,
    );
  }
}

/**
 * Parses `docker ps` `{{.CreatedAt}}` (`2026-10-07 12:00:00 +0800 CST`) using only the numeric
 * offset: `Date.parse` misreads zone abbreviations (CST as US Central) or returns NaN, and NaN
 * entries are never swept.
 */
export function parseDockerCreatedAt(value: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(?:([+-])(\d{2}):?(\d{2}))?/.exec(
    value.trim(),
  );
  if (!m) return Number.NaN;
  const [, date, time, sign, hh, mm] = m;
  const zone = sign ? `${sign}${hh}:${mm}` : 'Z';
  return Date.parse(`${date}T${time}${zone}`);
}

/**
 * Picks orphans from `docker ps` output (name, createdAt, owner):
 * - with an owner label and a live-owner set: removed iff the owner is gone, regardless of age;
 * - otherwise: by age ({@link ORPHAN_AGE_CUTOFF_MS}).
 * Unparseable times are skipped.
 */
export function orphanNamesToRemove(
  psOutput: string,
  cutoffMs: number,
  liveOwners?: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const line of psOutput.split('\n')) {
    const [name, createdAt, owner] = line.split('\t');
    if (!name || !createdAt) continue;
    if (owner && liveOwners) {
      if (!liveOwners.has(owner)) out.push(name);
      continue;
    }
    const created = parseDockerCreatedAt(createdAt);
    if (Number.isNaN(created) || created > cutoffMs) continue;
    out.push(name);
  }
  return out;
}

export interface DockerBackendOptions {
  dockerBin?: string;
  /**
   * Internal network (e.g. `winnowl_sandbox-egress`) whose only peer is the squid egress proxy.
   * Required for allowlist policies, which fail closed without it.
   */
  egressNetwork?: string;
  /**
   * Internal network of `package-registry-only` sandboxes (e.g. `winnowl_sandbox-registry`), whose
   * only way out is registry-proxy (package registries only). Without it that policy fails closed.
   */
  registryNetwork?: string;
  /** Runner worker id, written to each sandbox's owner label for orphan sweeps. */
  ownerId?: string;
  /**
   * Container uid:gid (default 65534, nobody). The rootfs is read-only and nobody has no writable
   * HOME, so images that run a repository's install/build need their own build user.
   */
  runAsUser?: number;
  /**
   * Disk-quota slots (sandbox hosts, `deploy/scratch-slots.sh`): a `workspace: 'disk'` sandbox
   * takes one, so what it writes has a hard limit. Without it such sandboxes get an anonymous
   * volume (no limit; local development). Shared by all backends of one host.
   */
  scratch?: ScratchSlotPool;
}

interface HandleMeta {
  image: string;
  runtime: string;
  /** Disk workspace limit (MiB) for slot-less volumes; tmpfs workspaces are limited by size. */
  diskLimitMb?: number;
  /** Highest non-reclaimable memory seen while commands ran (MiB). */
  memoryPeakMb: number;
}

/**
 * Docker sandbox backend. Hardening: network none by default, --cap-drop ALL, no-new-privileges,
 * pids/memory/cpu limits, read-only rootfs, no docker socket. The OCI runtime is pluggable.
 */
export class DockerSandboxBackend implements SandboxBackend {
  private readonly docker: string;
  private readonly networks: SandboxNetworks;
  private readonly meta = new Map<string, HandleMeta>();

  private readonly ownerId: string | undefined;
  private readonly runAsUser: number;
  private readonly scratch: ScratchSlotPool | undefined;

  constructor(options: DockerBackendOptions = {}) {
    this.docker = options.dockerBin ?? 'docker';
    this.networks = {
      ...(options.egressNetwork ? { egress: options.egressNetwork } : {}),
      ...(options.registryNetwork ? { registry: options.registryNetwork } : {}),
    };
    this.ownerId = options.ownerId;
    this.runAsUser = options.runAsUser ?? DEFAULT_RUN_AS_USER;
    this.scratch = options.scratch;
  }

  /**
   * Pulls the image on first use. Large images that are rarely used (the fix validation image is
   * ~6 GB and off by default) are then only on hosts that ran one; the pull gets its own long
   * timeout instead of the create's. Concurrent pulls of one image are merged by dockerd.
   */
  private async ensureImage(image: string): Promise<void> {
    const present = await runProcess(this.docker, ['image', 'inspect', '--format', '{{.Id}}', image], {
      timeoutMs: 30_000,
    });
    if (present.code === 0) return;
    const pulled = await runProcess(this.docker, ['pull', '-q', image], { timeoutMs: 14 * 60_000 });
    if (pulled.code !== 0) {
      throw new Error(`sandbox image ${image} is not on this host and could not be pulled: ${pulled.stderr.trim()}`);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await runProcess(this.docker, ['version', '--format', '{{.Server.Version}}'], {
        timeoutMs: 10_000,
      });
      return r.code === 0;
    } catch {
      return false;
    }
  }

  /**
   * `readonlyBinds` is for the sandbox agent only (it resolves `spec.mountWorkspace` to a host path
   * it owns); it is never taken from a spec.
   */
  async create(spec: SandboxSpec, opts: { readonlyBinds?: readonly { src: string; dst: string }[] } = {}): Promise<SandboxHandle> {
    const name = `${NAME_PREFIX}${uuidv7()}`;
    const runtime = spec.runtime ?? 'runc';

    await this.ensureImage(spec.image);
    let scratch: { slot: number; dir: string } | undefined;
    if (spec.resources.workspace === 'disk' && this.scratch) {
      const slot = await this.scratch.acquire(name, spec.resources.diskMb);
      scratch = { slot, dir: this.scratch.dir(slot) };
    }
    // spec.labels cannot override the internal ownership labels.
    const args = dockerCreateArgs(name, spec, this.networks, this.runAsUser, this.ownerId, scratch, opts.readonlyBinds);

    const created = await runProcess(this.docker, args, { timeoutMs: 120_000 });
    if (created.code !== 0) {
      this.scratch?.release(name);
      throw new Error(`sandbox create 失败: ${created.stderr.trim() || created.stdout.trim()}`);
    }
    const containerId = created.stdout.trim();

    const started = await runProcess(this.docker, ['start', name], { timeoutMs: 30_000 });
    if (started.code !== 0) {
      await this.forceRemove(name).catch(() => undefined);
      throw new Error(`sandbox start 失败: ${started.stderr.trim()}`);
    }
    /*
     * A new volume copies the image's /workspace mode; without it the volume is root-owned. Nothing in
     * the sandbox runs as root, so the image must ship /workspace with mode 1777; fail clearly otherwise.
     */
    if (spec.resources.workspace === 'disk') {
      const writable = await runProcess(this.docker, ['exec', name, 'test', '-w', '/workspace'], {
        timeoutMs: 30_000,
      });
      if (writable.code !== 0) {
        await this.forceRemove(name).catch(() => undefined);
        throw new Error(
          `sandbox 磁盘工作区不可写:镜像 ${spec.image} 需要自带 mode 1777 的 /workspace(或改用 workspace=memory)`,
        );
      }
    }

    this.meta.set(name, {
      image: spec.image,
      runtime,
      // With a slot the quota limits the disk; the byte counting below is for slot-less volumes.
      ...(spec.resources.workspace === 'disk' && !scratch ? { diskLimitMb: spec.resources.diskMb } : {}),
      memoryPeakMb: 0,
    });
    return { id: name, containerId };
  }

  async exec(handle: SandboxHandle, req: ExecRequest): Promise<ExecResult> {
    const timeoutSec = Math.max(1, Math.ceil(req.timeoutMs / 1000));
    const envFlags = Object.entries(req.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    // Enforced inside the container; the host-side timeout is a backstop.
    const inner = ['timeout', '-s', 'KILL', String(timeoutSec), ...req.argv];
    const args = ['exec', '-w', req.cwd ?? '/workspace', ...envFlags, handle.id, ...inner];

    // OOM kills of exec'd processes only show in the cgroup's counter; memory is sampled meanwhile.
    const before = await this.cgroup(handle.id);
    const sampler = this.sampleWhile(handle.id);
    let r: Awaited<ReturnType<typeof runProcess>>;
    try {
      r = await runProcess(this.docker, args, {
        timeoutMs: req.timeoutMs + 5_000,
        maxOutputBytes: req.maxOutputBytes,
      });
    } finally {
      sampler.stop();
    }
    const after = await this.cgroup(handle.id);
    this.notePeak(handle.id, after);
    const oom = before !== undefined && after !== undefined && after.oomKills > before.oomKills;
    const timedOut = dockerExecTimedOut({
      code: r.code,
      processTimedOut: r.timedOut,
      durationMs: r.durationMs,
      timeoutMs: req.timeoutMs,
      oomKilled: oom,
    });
    const meta = this.meta.get(handle.id) ?? { image: 'unknown', runtime: 'unknown' };

    return {
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      stdoutTruncated: r.stdoutTruncated,
      stderrTruncated: r.stderrTruncated,
      timedOut,
      durationMs: r.durationMs,
      ...(oom ? { oomKilled: true } : {}),
      evidence: {
        image: meta.image,
        runtime: meta.runtime,
        argv: req.argv,
        purpose: req.purpose,
        exitCode: r.code,
        timedOut,
        durationMs: r.durationMs,
      },
    };
  }

  /** One cgroup reading; undefined when the container cannot be asked (gone, or no cgroup v2). */
  private async cgroup(name: string): Promise<CgroupSample | undefined> {
    const r = await runProcess(
      this.docker,
      ['exec', name, 'cat', '/sys/fs/cgroup/memory.stat', '/sys/fs/cgroup/memory.events'],
      { timeoutMs: 10_000 },
    ).catch(() => undefined);
    return r?.code === 0 ? parseCgroupSample(r.stdout) : undefined;
  }

  private notePeak(name: string, sample: CgroupSample | undefined): void {
    const meta = this.meta.get(name);
    if (meta && sample) meta.memoryPeakMb = Math.max(meta.memoryPeakMb, sample.usedMb);
  }

  /** Samples memory every few seconds until stopped (one reading at a time). */
  private sampleWhile(name: string): { stop(): void } {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.cgroup(name)
        .then((s) => this.notePeak(name, s))
        .finally(() => (busy = false));
    }, SAMPLE_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }

  /**
   * Changes the limits of a running sandbox (`docker update`, no restart). Disk first: it is the
   * part that can be refused for want of room, and then nothing has changed yet.
   */
  async resize(handle: SandboxHandle, req: SandboxResize): Promise<SandboxUsage> {
    if (req.stopProcesses) {
      await runProcess(this.docker, ['exec', handle.id, 'sh', '-c', STOP_PROCESSES], { timeoutMs: 15_000 });
    }
    if (req.diskMb !== undefined) {
      if (!this.scratch) throw new Error('this host has no disk-quota slots; disk cannot be resized');
      await this.scratch.resize(handle.id, req.diskMb);
    }
    if (req.memoryMb !== undefined || req.swapMb !== undefined || req.cpus !== undefined) {
      const cur = await this.limits(handle.id);
      const memoryMb = req.memoryMb ?? cur.memoryMb;
      const swapMb = req.swapMb ?? cur.swapMb;
      const cpus = req.cpus ?? cur.cpus;
      const r = await runProcess(
        this.docker,
        ['update', '--memory', `${memoryMb}m`, '--memory-swap', `${memoryMb + swapMb}m`, '--cpus', String(cpus), handle.id],
        { timeoutMs: 30_000 },
      );
      if (r.code !== 0) throw new Error(`sandbox resize failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return this.usage(handle);
  }

  async usage(handle: SandboxHandle): Promise<SandboxUsage> {
    const [limits, sample, disk] = await Promise.all([
      this.limits(handle.id),
      this.cgroup(handle.id),
      this.scratch?.usage(handle.id),
    ]);
    this.notePeak(handle.id, sample);
    return {
      ...limits,
      memoryUsedMb: sample?.usedMb ?? 0,
      memoryPeakMb: Math.max(this.meta.get(handle.id)?.memoryPeakMb ?? 0, sample?.usedMb ?? 0),
      oomKills: sample?.oomKills ?? 0,
      ...(disk ? { diskMb: disk.limitMb, diskUsedMb: disk.usedMb, diskPeakMb: disk.peakMb } : {}),
    };
  }

  private async limits(name: string): Promise<{ cpus: number; memoryMb: number; swapMb: number }> {
    const r = await runProcess(
      this.docker,
      ['inspect', '--format', '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.NanoCpus}}', name],
      { timeoutMs: 15_000 },
    );
    if (r.code !== 0) throw new Error(`docker inspect failed: ${r.stderr.trim()}`);
    const [mem, memSwap, nano] = r.stdout.trim().split(/\s+/).map(Number);
    const mib = 1024 * 1024;
    const memoryMb = Math.round((mem ?? 0) / mib);
    return {
      memoryMb,
      // -1 = unlimited swap (never set by us); treated as none.
      swapMb: memSwap && memSwap > 0 ? Math.max(0, Math.round(memSwap / mib) - memoryMb) : 0,
      cpus: (nano ?? 0) / 1e9,
    };
  }

  async putFile(handle: SandboxHandle, req: PutFileRequest): Promise<void> {
    const r = await runProcess(
      this.docker,
      ['exec', '-i', handle.id, 'sh', '-c', 'cat > "$1"', 'sh', req.path],
      { input: req.content, timeoutMs: 30_000 },
    );
    if (r.code !== 0) {
      throw new Error(`putFile 失败: ${r.stderr.trim()}`);
    }
  }

  async getArtifact(handle: SandboxHandle, path: string): Promise<ArtifactContent> {
    const r = await runProcess(
      this.docker,
      ['exec', handle.id, 'sh', '-c', 'cat "$1"', 'sh', path],
      { timeoutMs: 30_000, maxOutputBytes: 10_000_000 },
    );
    if (r.code !== 0) {
      throw new Error(`getArtifact 失败: ${r.stderr.trim()}`);
    }
    return { path, content: r.stdout, bytes: Buffer.byteLength(r.stdout, 'utf8') };
  }

  /**
   * Streams a tar of the local directory into `docker exec -i ... tar -x`. Not `docker cp`: the daemon
   * refuses cp into `--read-only` containers even when the target is a tmpfs mount.
   */
  async copyInto(
    handle: SandboxHandle,
    srcHostDir: string,
    destContainerDir: string,
  ): Promise<void> {
    // The disk workspace volume has no quota, so check the size before copying (review never writes more).
    const limitMb = this.meta.get(handle.id)?.diskLimitMb;
    if (limitMb !== undefined) {
      const sizeMb = await directorySizeMb(srcHostDir);
      if (sizeMb > limitMb) {
        throw new Error(`copyInto: ${srcHostDir} 有 ${sizeMb} MiB,超过沙盒工作区上限 ${limitMb} MiB`);
      }
    }
    const tar = tarDirectory(srcHostDir);
    try {
      await this.extractTarInto(handle, tar.stream, destContainerDir);
    } catch (err) {
      tar.abort();
      throw err;
    }
    await tar.done;
  }

  /** Shared by `copyInto` and sandbox-agent (HTTP request bodies). argv is passed directly, without a shell. */
  async extractTarInto(
    handle: SandboxHandle,
    tar: Readable,
    destContainerDir: string,
    timeoutMs = 120_000,
  ): Promise<void> {
    const mk = await runProcess(this.docker, ['exec', handle.id, 'mkdir', '-p', destContainerDir], {
      timeoutMs: 30_000,
    });
    if (mk.code !== 0) throw new Error(`copyInto mkdir 失败: ${mk.stderr.trim()}`);
    // No quota on the disk workspace: bytes streamed here are what gets written (tar headers only overcount).
    const limitMb = this.meta.get(handle.id)?.diskLimitMb;
    const source = limitMb === undefined ? tar : tar.pipe(byteLimit(limitMb * 1024 * 1024));
    const r = await runProcessFromStream(
      this.docker,
      ['exec', '-i', handle.id, 'tar', '-xf', '-', '-C', destContainerDir],
      source,
      { timeoutMs, maxOutputBytes: 1_000_000 },
    );
    if (source !== tar && (source as Transform & { exceeded?: boolean }).exceeded) {
      throw new Error(`copyInto: 代码树超过沙盒工作区上限 ${limitMb} MiB`);
    }
    if (r.code !== 0) throw new Error(`copyInto(tar via exec)失败: ${r.stderr.trim()}`);
  }

  /**
   * Removes orphaned sandbox containers (the control plane was SIGKILLed before cleanup). Returns the
   * count; never throws, so a failed sweep cannot block startup.
   */
  async sweepOrphans(olderThanMs: number, liveOwners?: ReadonlySet<string>): Promise<number> {
    assertOrphanAgeCutoff(olderThanMs);
    const names = new Set<string>();

    // Labelled containers selected by owner liveness or age, including ones still running.
    const labeled = await runProcess(
      this.docker,
      [
        'ps',
        '-a',
        '--filter',
        `label=${SANDBOX_LABEL}=review`,
        '--format',
        `{{.Names}}\t{{.CreatedAt}}\t{{.Label "${OWNER_LABEL}"}}`,
      ],
      { timeoutMs: 15_000 },
    ).catch(() => null);
    if (labeled?.code === 0) {
      for (const n of orphanNamesToRemove(labeled.stdout, Date.now() - olderThanMs, liveOwners))
        names.add(n);
    }

    // Any exited `rvb-` container regardless of age: it cannot be in use. Also catches pre-label leftovers.
    const exited = await runProcess(
      this.docker,
      [
        'ps',
        '-a',
        '--filter',
        `name=${NAME_PREFIX}`,
        '--filter',
        'status=exited',
        '--format',
        '{{.Names}}',
      ],
      { timeoutMs: 15_000 },
    ).catch(() => null);
    if (exited?.code === 0) {
      for (const line of exited.stdout.split('\n')) {
        const name = line.trim();
        if (name.startsWith(NAME_PREFIX)) names.add(name);
      }
    }

    for (const name of names) await this.forceRemove(name).catch(() => undefined);
    return names.size;
  }

  /** forceRemove throws, so the meta entry is dropped in finally. */
  async destroy(handle: SandboxHandle): Promise<void> {
    try {
      await this.forceRemove(handle.id);
    } finally {
      this.meta.delete(handle.id);
    }
  }

  private async forceRemove(name: string): Promise<void> {
    // -v: the disk workspace is an anonymous volume.
    const result = await runProcess(this.docker, ['rm', '-f', '-v', name], { timeoutMs: 30_000 });
    if (
      result.code !== 0 &&
      !/No such container|not found/i.test(`${result.stdout}\n${result.stderr}`)
    ) {
      throw new Error(`sandbox remove failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    // Gone: its scratch slot (if any) is cleared and free again.
    this.scratch?.release(name);
  }
}
