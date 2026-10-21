// Backends are replaceable; the security suite is the admission bar for any of them.

/** Default none. */
export type NetworkPolicy =
  | { mode: 'none' }
  | { mode: 'package-registry-only'; ecosystems: string[] }
  | { mode: 'allowlist'; hosts: string[]; ports?: number[] }
  | { mode: 'full'; adminApproved: true };

/** Enough for review / scanner tools, which keep little in /tmp. */
export const DEFAULT_SCRATCH_MB = 64;

/** Scheduling order when hosts are full: reviews someone waits for, scans feeding them, then best-effort validation. */
export const SANDBOX_PRIORITY = { review: 30, scan: 20, validation: 10 } as const;

export interface SandboxResources {
  cpus: number;
  memoryMb: number;
  /** Fork bomb bound. */
  pids: number;
  /** Writable workspace size (MiB); docker enforces it only with `workspace: 'memory'` (tmpfs size). */
  diskMb: number;
  /**
   * `memory` (default): tmpfs, counted against `memoryMb`. `disk`: a volume removed with the container;
   * docker's local driver has no quota, so `diskMb` is not enforced there.
   */
  workspace?: 'memory' | 'disk';
  /**
   * Writable `/tmp` (MiB, default 64), always memory-backed. Toolchains keep HOME and caches there
   * (the rootfs is read-only), so builds need much more than the default.
   */
  scratchMb?: number;
  /** Swap on top of `memoryMb` (MiB, default 0) for short peaks; scheduling counts `memoryMb` only. */
  swapMb?: number;
}

/** Absent fields stay. Growing takes host room (multi-host backends wait for it). */
export interface SandboxResize {
  cpus?: number;
  memoryMb?: number;
  swapMb?: number;
  /** Disk-quota limit of the sandbox's slot (sandbox hosts with slots only). */
  diskMb?: number;
  /** Kill every process except init first; shrinking memory under live processes OOM-kills them. */
  stopProcesses?: boolean;
}

export interface SandboxUsage {
  cpus: number;
  memoryMb: number;
  swapMb: number;
  /** Slot limit; absent without a disk-quota slot. */
  diskMb?: number;
  /** Unreclaimable memory (anon + shmem, no page cache). */
  memoryUsedMb: number;
  /** Sampled while commands ran. */
  memoryPeakMb: number;
  diskUsedMb?: number;
  diskPeakMb?: number;
  /** Cumulative. */
  oomKills: number;
}

export interface SandboxSpec {
  image: string;
  network: NetworkPolicy;
  resources: SandboxResources;
  env?: Record<string, string>;
  /**
   * Allow running programs from `/workspace` and `/tmp` (default noexec). Builds need it; only for
   * sandboxes that run the repository's own build anyway, where noexec is no boundary.
   */
  writableExec?: boolean;
  /** Higher first on a shared pool (default 0); see `SANDBOX_PRIORITY`. */
  priority?: number;
  /**
   * Sandbox hosts: mount a workspace's head tree read-only at `dest` instead of copying it. The
   * workspace must be on the same host (`placement`). Read-only users only; builds need a copy.
   */
  mountWorkspace?: { workspaceId: string; dest: string };
  /** Hard upper bound on container lifetime. */
  maxLifetimeSeconds?: number;
  /** runc (default) / runsc (gVisor) / kata-runtime. */
  runtime?: string;
  labels?: Record<string, string>;
  /** Multi-host backends: the host this sandbox must run on (e.g. the one holding the workspace). */
  placement?: string;
}

export interface SandboxHandle {
  id: string;
  containerId: string;
}

export type ExecPurpose =
  | 'inspect'
  | 'bootstrap'
  | 'build'
  | 'lint'
  | 'test'
  | 'static-analysis'
  | 'confirm'
  | 'differential'
  | 'autofix-validation';

export interface ExecRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  purpose: ExecPurpose;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandEvidence {
  image: string;
  runtime: string;
  argv: string[];
  purpose: ExecPurpose;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /**
   * The OOM killer ended a process of this command (cgroup `memory.events`); the container's
   * `OOMKilled` only covers init, never an exec'd command.
   */
  oomKilled?: boolean;
  evidence: CommandEvidence;
}

export interface PutFileRequest {
  /** Must be inside the workspace. */
  path: string;
  content: string;
}

export interface ArtifactContent {
  path: string;
  content: string;
  bytes: number;
}

export interface SandboxBackend {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, req: ExecRequest): Promise<ExecResult>;
  putFile(handle: SandboxHandle, req: PutFileRequest): Promise<void>;
  getArtifact(handle: SandboxHandle, path: string): Promise<ArtifactContent>;
  /** Streams a local directory into the container (docker cp from the CLI's filesystem, avoiding DinD host paths). */
  copyInto?(handle: SandboxHandle, srcHostDir: string, destContainerDir: string): Promise<void>;
  destroy(handle: SandboxHandle): Promise<void>;
  resize?(handle: SandboxHandle, req: SandboxResize): Promise<SandboxUsage>;
  /** Peaks are since creation. */
  usage?(handle: SandboxHandle): Promise<SandboxUsage>;
  /**
   * Removes orphaned sandboxes; returns the count. Must only touch containers older than olderThanMs
   * so in-flight sandboxes of other instances on the host survive.
   */
  sweepOrphans?(olderThanMs: number, liveOwners?: ReadonlySet<string>): Promise<number>;
  /** Copies a workspace's head worktree (on the sandbox's own host) into the sandbox. Multi-host backends only. */
  copyFromWorkspace?(
    handle: SandboxHandle,
    workspace: { host: string; workspaceId: string },
    destContainerDir: string,
  ): Promise<void>;
}
