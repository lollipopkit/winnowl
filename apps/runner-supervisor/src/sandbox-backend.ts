import { createHmac } from 'node:crypto';
import {
  AgentPoolSandboxBackend,
  DockerSandboxBackend,
  parseAgentHosts,
  type SandboxBackend,
  type SandboxResources,
} from '@reviewbot/sandbox';

/**
 * Sandboxes the backend runs at once: the default concurrency of the runner's sandbox lane
 * (an explicit RUNNER_CONCURRENCY still wins).
 */
export function sandboxCapacity(env: NodeJS.ProcessEnv = process.env): number {
  if (env.SANDBOX_BACKEND === 'agents') {
    return parseAgentHosts(env.SANDBOX_AGENTS ?? '').reduce((n, h) => n + h.slots, 0) || 1;
  }
  return 1;
}

/**
 * Size of review sandboxes (and scan sandboxes next to a workspace). Env can shrink them for small
 * nodes; the checked-out tree goes on a disk volume unless REVIEW_SANDBOX_WORKSPACE=memory.
 */
export function reviewSandboxResources(env: NodeJS.ProcessEnv = process.env): SandboxResources {
  return {
    workspace: env.REVIEW_SANDBOX_WORKSPACE === 'memory' ? 'memory' : 'disk',
    cpus: Number(env.REVIEW_SANDBOX_CPUS) || 2,
    memoryMb: Number(env.REVIEW_SANDBOX_MEMORY_MB) || 2048,
    pids: Number(env.REVIEW_SANDBOX_PIDS) || 512,
    diskMb: Number(env.REVIEW_SANDBOX_DISK_MB) || 2048,
  };
}

/**
 * Per-host agent token, derived instead of stored: HMAC(SANDBOX_AGENT_SECRET, host name). The
 * agent only holds its sha256 (scripts/deploy-live.sh computes and installs it).
 */
export function agentToken(secret: string, host: string): string {
  return createHmac('sha256', secret).update(host).digest('hex');
}

/**
 * Sandbox backend by SANDBOX_BACKEND: `agents` = fixed sandbox hosts (`SANDBOX_AGENTS=name=url=slots,…`,
 * this process never touches docker); default `docker` = single host via docker.sock.
 * Must be built after worker registration: sandboxes are labelled with the workerId for orphan cleanup.
 */
export function createSandboxBackend(input: {
  workerId: string;
  logger: Record<'info' | 'warn', (data: Record<string, unknown>, message: string) => void>;
  env?: NodeJS.ProcessEnv;
}): { sandbox: SandboxBackend } {
  const env = input.env ?? process.env;
  if (env.SANDBOX_BACKEND === 'agents') {
    const secret = env.SANDBOX_AGENT_SECRET?.trim();
    if (!secret) throw new Error('SANDBOX_BACKEND=agents requires SANDBOX_AGENT_SECRET');
    return {
      sandbox: new AgentPoolSandboxBackend({
        hosts: parseAgentHosts(env.SANDBOX_AGENTS ?? ''),
        tokenFor: (host) => agentToken(secret, host),
        ownerId: input.workerId,
        // The executor inside the sandbox must be this commit (scripts/deploy-live.sh sets it).
        ...(env.APP_VERSION ? { version: env.APP_VERSION } : {}),
        log: (level, message, data) => input.logger[level](data ?? {}, message),
      }),
    };
  }
  return {
    sandbox: new DockerSandboxBackend({
      // Internal egress network: with the allowlist policy, sandboxes join it and all egress goes through squid.
      ...(env.SANDBOX_EGRESS_NETWORK ? { egressNetwork: env.SANDBOX_EGRESS_NETWORK } : {}),
      // Validation sandboxes (package-registry-only) → registry-proxy only.
      ...(env.SANDBOX_REGISTRY_NETWORK ? { registryNetwork: env.SANDBOX_REGISTRY_NETWORK } : {}),
      ownerId: input.workerId,
    }),
  };
}
