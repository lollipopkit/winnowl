import { ScratchSlotPool, SocketScratchQuota } from '@reviewbot/sandbox';
import { DockerAgentRuntime } from './runtime.js';
import { buildAgent } from './server.js';
import { LocalWorkspaceStore } from './workspaces.js';

// Config is env-only; only the agent token's sha256 is present here.
const tokenSha256 = process.env.AGENT_TOKEN_SHA256 ?? '';
const allowedImages = new Set(
  (process.env.AGENT_ALLOWED_IMAGES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
if (!/^[0-9a-f]{64}$/.test(tokenSha256) || allowedImages.size === 0) {
  console.error('sandbox-agent requires AGENT_TOKEN_SHA256 (hex) and AGENT_ALLOWED_IMAGES');
  process.exit(1);
}
const maxSandboxes = Math.max(0, Math.floor(Number(process.env.AGENT_MAX_SANDBOXES) || 0));
// Memory budget for sandboxes (MiB, sum of their limits); unset = only the count cap applies.
const maxMemoryMb = Math.max(0, Math.floor(Number(process.env.AGENT_MEMORY_MB) || 0));
// Must stay below the container's stop grace period (docker-compose.sandbox-host.yml).
const drainTimeoutMs = Number(process.env.AGENT_DRAIN_TIMEOUT_MS) || 40 * 60_000;

// Disk sandboxes write into quota-limited slots, set through the host's quota service socket.
const scratchRoot = process.env.AGENT_SCRATCH_ROOT?.trim();
const scratchSlots = Math.max(0, Math.floor(Number(process.env.AGENT_SCRATCH_SLOTS) || 0));
const scratchPoolMb = Math.max(0, Math.floor(Number(process.env.AGENT_SCRATCH_POOL_MB) || 0));
const scratchMaxSlotMb = Math.max(0, Math.floor(Number(process.env.AGENT_SCRATCH_MAX_SLOT_MB) || 0)) || scratchPoolMb;
const scratchQuotaSocket = process.env.AGENT_SCRATCH_QUOTA_SOCKET?.trim() || '/run/winnowl-scratch-quota.sock';
if (scratchRoot && scratchSlots > 0 && scratchPoolMb === 0) {
  console.error('AGENT_SCRATCH_SLOTS requires AGENT_SCRATCH_POOL_MB (the sum of the slot limits)');
  process.exit(1);
}
const runtime = new DockerAgentRuntime({
  egressNetwork: process.env.AGENT_EGRESS_NETWORK ?? 'sandbox-egress',
  ...(scratchRoot && scratchSlots > 0
    ? {
        scratch: new ScratchSlotPool({
          root: scratchRoot,
          slots: scratchSlots,
          poolMb: scratchPoolMb,
          maxSlotMb: scratchMaxSlotMb,
          quota: new SocketScratchQuota(scratchQuotaSocket),
          // Any allowed image clears a slot; the first one is the sandbox image itself.
          image: [...allowedImages][0]!,
        }),
      }
    : {}),
  // Validation sandboxes (package-registry-only); unset = that policy fails closed.
  ...(process.env.AGENT_REGISTRY_NETWORK ? { registryNetwork: process.env.AGENT_REGISTRY_NETWORK } : {}),
});
await runtime.adoptScratchSlots();
const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT ?? '/var/lib/winnowl/workspaces';
const workspaces = new LocalWorkspaceStore(workspaceRoot);
// The same directory as the host sees it (bind-mounted in): sandboxes mount workspaces from there.
const workspaceHostRoot = process.env.AGENT_WORKSPACE_HOST_ROOT?.trim();
await workspaces.init();
const maxWorkspaces = Math.max(0, Math.floor(Number(process.env.AGENT_MAX_WORKSPACES) || 2 * maxSandboxes));
let draining = false;
const app = await buildAgent({
  runtime,
  tokenSha256,
  allowedImages,
  version: process.env.APP_VERSION ?? '0.0.0',
  ...(maxSandboxes > 0 ? { maxSandboxes } : {}),
  ...(maxMemoryMb > 0 ? { maxMemoryMb } : {}),
  ...(workspaceHostRoot
    ? { workspaceHostRoot: { container: workspaceRoot.replace(/\/+$/, ''), host: workspaceHostRoot.replace(/\/+$/, '') } }
    : {}),
  ...(/^[0-9a-f]{64}$/.test(process.env.AGENT_METRICS_TOKEN_SHA256 ?? '')
    ? { metricsTokenSha256: process.env.AGENT_METRICS_TOKEN_SHA256! }
    : {}),
  draining: () => draining,
  workspaces,
  ...(maxWorkspaces > 0 ? { maxWorkspaces } : {}),
});

// First signal drains (running sandboxes' exec streams live in this process); second exits now.
const shutdown = (): void => {
  if (draining) {
    void app.close().then(() => process.exit(0));
    return;
  }
  draining = true;
  app.log.info('draining: no new sandboxes or workspaces; waiting for the running ones');
  const deadline = Date.now() + drainTimeoutMs;
  const poll = async (): Promise<void> => {
    const left = (await runtime.count().catch(() => 0)) + workspaces.count();
    if (left === 0 || Date.now() >= deadline) {
      await app.close();
      process.exit(0);
    }
    setTimeout(() => void poll(), 5_000);
  };
  void poll();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 80) });
