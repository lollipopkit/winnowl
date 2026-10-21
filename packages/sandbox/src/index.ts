export type {
  SandboxBackend,
  SandboxSpec,
  SandboxHandle,
  SandboxResources,
  NetworkPolicy,
  ExecRequest,
  ExecResult,
  ExecPurpose,
  CommandEvidence,
  PutFileRequest,
  ArtifactContent,
  SandboxResize,
  SandboxUsage,
} from './types.js';

export {
  DockerSandboxBackend,
  byteLimit,
  directorySizeMb,
  dockerCreateArgs,
  SCRATCH_SLOT_LABEL,
  MAX_SANDBOX_LIFETIME_MS,
  ORPHAN_AGE_CUTOFF_MS,
  assertOrphanAgeCutoff,
  dockerExecTimedOut,
  orphanNamesToRemove,
  parseCgroupSample,
  parseDockerCreatedAt,
} from './docker-backend.js';
export type { DockerBackendOptions } from './docker-backend.js';
export { SANDBOX_PRIORITY } from './types.js';
export { ScratchSlotPool, ScratchSlotsExhaustedError, SocketScratchQuota, parseScratchReport } from './scratch-slots.js';
export type { ScratchQuota, ScratchReport } from './scratch-slots.js';

export {
  dockerNetworkArgs,
  PERMANENT_BLOCK_CIDRS,
  UnsupportedNetworkPolicyError,
} from './network.js';
export type { SandboxNetworks } from './network.js';

export { applyRepoSandboxPolicy } from './policy.js';
export type { RepoSandboxConfig } from './policy.js';

export { buildEgressProxyConfig, allowedHostsFor, REGISTRY_ECOSYSTEMS } from './egress.js';
export type { EgressProxyConfig } from './egress.js';

export { runProcess } from './exec.js';
export type { RunOptions, RunResult } from './exec.js';
export { runProcessFromStream, tarDirectory } from './exec.js';

export { HttpSandboxBackend, AgentRequestError } from './http-backend.js';
export { AgentPoolSandboxBackend, parseAgentHosts, SandboxCapacityError } from './agent-pool.js';
export type { AgentPoolHost, AgentPoolOptions, AgentClient, PoolWorkspace } from './agent-pool.js';
export type { HttpBackendOptions } from './http-backend.js';
export { AGENT_API_PREFIX, SSE_PING_MS, SseParser, formatSseEvent } from './agent-protocol.js';
export type {
  AgentCreateRequest,
  AgentCreateResult,
  AgentError,
  AgentExecRequest,
  AgentExecStarted,
  AgentHealth,
  AgentSweepRequest,
  AgentSweepResult,
  AgentTreeFromWorkspaceRequest,
  AgentWorkspaceOpenRequest,
  AgentWorkspaceOpenResult,
  SseEvent,
} from './agent-protocol.js';
