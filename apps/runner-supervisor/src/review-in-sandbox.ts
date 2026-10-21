import type { StreamFailureKind } from '@reviewbot/agent-pi';
import { relayOtlpFile } from '@reviewbot/telemetry';
import { SANDBOX_PRIORITY, type SandboxBackend, type SandboxHandle, type SandboxResources, type NetworkPolicy } from '@reviewbot/sandbox';
import { ReviewIncompleteError } from '@reviewbot/review-orchestrator';
import { canReceiveWorkspace, readOnlyTree, workspaceMount, workspacePlacement } from './code-plane.js';
import { relayExecutorSpec, type CodePlane, type ReviewExecutorOutput, type ReviewExecutorSpec } from '@reviewbot/review-runtime';
import type { LlmRelayClient, RelayGrant } from './llm-relay.js';

/**
 * Control-plane side of running review exploration + verification in a sandbox: no secrets in the
 * sandbox env, read-only tree, network locked to the egress proxy.
 */

export interface RunInSandboxDeps {
  sandbox: SandboxBackend;
  image: string;
  resources: SandboxResources;
  log: (message: string, data?: Record<string, unknown>) => void;
  /** The sandbox has no DB, so progress is polled from a file the executor writes. */
  onProgress?: (p: { stage: string; done?: number; total?: number }) => void;
  /** When true, a cancel sentinel is written that the executor checks before each billable step. */
  isCancelled?: () => boolean | Promise<boolean>;
  /**
   * With the relay the sandbox gets no key at all; models and keyed plugins go through it with a
   * per-review token. Required on sandbox hosts (`requireRelay`), which must never see a key.
   */
  relay?: LlmRelayClient;
  requireRelay?: boolean;
}

const WORKTREE = '/workspace/worktree';
const PROGRESS = '/workspace/progress.json';
const PROGRESS_POLL_MS = 5_000;
const CANCEL = '/workspace/cancel';
const CANCEL_POLL_MS = 5_000;
/** The trace collector is unreachable from the sandbox; spans are read from here and relayed. */
const SPANS = '/workspace/spans.json';
const INPUT = '/workspace/input.json';
const OUTPUT = '/workspace/output.json';
const EXECUTOR_ENTRY = '/app/apps/review-executor/dist/index.mjs';

function langfuseExport(): { endpoint: string; headers: Record<string, string> } | undefined {
  const endpoint = process.env.LANGFUSE_OTLP_ENDPOINT;
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;
  if (!endpoint || !pk || !sk) return undefined;
  return { endpoint, headers: { authorization: `Basic ${Buffer.from(`${pk}:${sk}`).toString('base64')}` } };
}

// `hosts` stays empty: the real allowlist lives in the squid config; the docker backend only joins
// the sandbox to the internal egress network where squid is the sole reachable host.
function resolveEgress(): { network: NetworkPolicy; egressProxyUrl?: string } {
  const proxy = process.env.SANDBOX_EGRESS_PROXY;
  if (proxy) return { network: { mode: 'allowlist', hosts: [] }, egressProxyUrl: proxy };
  throw new Error('review sandbox requires SANDBOX_EGRESS_PROXY');
}

/**
 * Sandboxes in use. A deploy's SIGKILL skips `finally`, so shutdown destroys these first, otherwise
 * containers linger until their max lifetime.
 */
const activeSandboxes = new Map<string, { handle: SandboxHandle; sandbox: SandboxBackend }>();

/** Called on SIGTERM; returns how many were destroyed. Never throws. */
export async function destroyActiveSandboxes(): Promise<number> {
  const entries = [...activeSandboxes.entries()];
  const results = await Promise.all(
    entries.map(async ([id, { handle, sandbox }]) => {
      const ok = await sandbox
        .destroy(handle)
        .then(() => true)
        .catch(() => false);
      if (ok) activeSandboxes.delete(id);
      return ok;
    }),
  );
  return results.filter(Boolean).length;
}

/**
 * Hard wall-clock cap for the executor (backend SIGKILLs, exit 137); stops a non-converging model
 * from holding a worker. Used only when a stage budget is off; max stage budgets sum to 90 minutes.
 */
const MAX_EXEC_TIMEOUT_MS = 95 * 60_000;
const EXEC_OVERHEAD_MS = 5 * 60_000;

/**
 * Sum of stage budgets + overhead, capped at {@link MAX_EXEC_TIMEOUT_MS}. Derived rather than fixed
 * because a stage timeout keeps partial output while this one SIGKILLs the whole run; it must sit
 * just after the last stage. dig and verify overlap, so the sum is an upper bound. Any stage `off`
 * falls back to the hard cap.
 */
export function execTimeoutMs(spec: ReviewExecutorSpec): number {
  const s = spec.stageBudgetMs;
  const stages = [s?.map, s?.dig, s?.synthesis, spec.verifyBudgetMs];
  if (stages.some((ms) => ms === undefined || ms <= 0)) return MAX_EXEC_TIMEOUT_MS;
  const sum = stages.reduce<number>((a, ms) => a + (ms ?? 0), 0);
  return Math.min(MAX_EXEC_TIMEOUT_MS, sum + EXEC_OVERHEAD_MS);
}

/** Can this backend give a sandbox the workspace's head tree (see `canReceiveWorkspace`)? */
export const canRunReviewInSandbox = canReceiveWorkspace;

export async function runReviewInSandbox(
  spec: ReviewExecutorSpec,
  workspace: CodePlane,
  deps: RunInSandboxDeps,
): Promise<ReviewExecutorOutput> {
  if (!canReceiveWorkspace(deps.sandbox, workspace))
    throw new Error('sandbox backend cannot receive this workspace (review-in-sandbox)');
  if (deps.requireRelay && !deps.relay) {
    throw new Error('review sandboxes on sandbox hosts require the model relay (LLM_RELAY_ADMIN_URL / LLM_RELAY_PUBLIC_URL)');
  }
  const { network, egressProxyUrl } = resolveEgress();
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined;
  // Without the relay the spec still carries Langfuse keys and the executor exports itself.
  const langfuse = deps.relay ? langfuseExport() : undefined;
  const timeoutMs = execTimeoutMs(spec);
  const handle = await deps.sandbox.create({
    image: deps.image,
    network,
    resources: deps.resources,
    // Outlives the exec timeout so artifacts can still be read before destroy.
    maxLifetimeSeconds: Math.ceil((timeoutMs + EXEC_OVERHEAD_MS) / 1000),
    // Opt-in (e.g. runsc for gVisor): hosts without that runtime would fail to create.
    ...(process.env.REVIEW_SANDBOX_RUNTIME ? { runtime: process.env.REVIEW_SANDBOX_RUNTIME } : {}),
    // The workspace's host, whose clone is mounted in read-only (never crosses the network).
    ...workspacePlacement(workspace),
    ...workspaceMount(workspace, WORKTREE),
    priority: SANDBOX_PRIORITY.review,
  });
  deps.log('review sandbox created', {
    container: handle.containerId,
    network: network.mode,
    timeoutMin: Math.round(timeoutMs / 60_000),
  });
  activeSandboxes.set(handle.id, { handle, sandbox: deps.sandbox });
  // Poll failures (file not written yet, partial JSON, container gone) are expected and ignored.
  const poll = deps.onProgress
    ? setInterval(() => {
        void deps.sandbox
          .getArtifact(handle, PROGRESS)
          .then((a) => {
            const p = JSON.parse(a.content) as { stage?: string; done?: number; total?: number };
            if (typeof p.stage === 'string')
              deps.onProgress?.({
                stage: p.stage,
                ...(typeof p.done === 'number' ? { done: p.done } : {}),
                ...(typeof p.total === 'number' ? { total: p.total } : {}),
              });
          })
          .catch(() => undefined);
      }, PROGRESS_POLL_MS)
    : undefined;
  poll?.unref();
  // Cancellation is passed as a sentinel file rather than killing the container, so the executor
  // still writes its output and the token usage spent so far is billed. A failed write retries next tick.
  let cancelSent = false;
  let cancelSending = false;
  const cancelPoll = deps.isCancelled
    ? setInterval(() => {
        if (cancelSent || cancelSending) return;
        cancelSending = true;
        void Promise.resolve(deps.isCancelled?.())
          .then(async (yes) => {
            if (!yes) return;
            await deps.sandbox.putFile(handle, { path: CANCEL, content: '1' });
            cancelSent = true;
            deps.log('review 取消信号已送入沙盒(executor 将在下一个花钱边界收工)', {
              container: handle.containerId,
            });
          })
          .catch(() => undefined)
          .finally(() => {
            cancelSending = false;
          });
      }, CANCEL_POLL_MS)
    : undefined;
  cancelPoll?.unref();
  let grant: RelayGrant | undefined;
  try {
    let sandboxSpec = spec;
    if (deps.relay) {
      // One grant per sandbox, alive as long as the sandbox may run.
      grant = await deps.relay.open(handle.id, timeoutMs + EXEC_OVERHEAD_MS, (relay) => {
        const relayed = relayExecutorSpec(spec, relay);
        sandboxSpec = relayed.spec;
        return relayed.upstreams;
      });
    }
    // The executor only reads source: the tree is read-only before it receives any model-controlled
    // input (mounted so on a sandbox host, copied and sealed otherwise); protocol files stay in the
    // writable /workspace outside this directory.
    await readOnlyTree(deps.sandbox, handle, workspace, WORKTREE);
    await deps.sandbox.putFile(handle, { path: INPUT, content: JSON.stringify(sandboxSpec) });
    const r = await deps.sandbox.exec(handle, {
      argv: ['node', EXECUTOR_ENTRY],
      // No secrets in env: only paths and the (non-secret) egress proxy URL.
      env: {
        INPUT_PATH: INPUT,
        OUTPUT_PATH: OUTPUT,
        WORKTREE_PATH: WORKTREE,
        // Passed explicitly so both sides cannot drift apart; a mismatch would fail silently.
        PROGRESS_PATH: PROGRESS,
        CANCEL_PATH: CANCEL,
        // The esbuild bundle resolves ATTR_SERVICE_NAME to undefined, so the service name must come from env.
        OTEL_SERVICE_NAME: 'winnowl-review-executor',
        ...(otlpEndpoint || langfuse ? { SPANS_PATH: SPANS } : {}),
        ...(egressProxyUrl
          ? {
              SANDBOX_EGRESS_PROXY: egressProxyUrl,
              // The OTLP exporter uses node:http/https, which ignores undici's dispatcher; Node's
              // built-in env proxy support (NODE_USE_ENV_PROXY) routes it through squid.
              HTTPS_PROXY: egressProxyUrl,
              HTTP_PROXY: egressProxyUrl,
              NODE_USE_ENV_PROXY: '1',
            }
          : {}),
      },
      purpose: 'confirm',
      timeoutMs,
      maxOutputBytes: 2_000_000,
    });
    if (r.exitCode !== 0) {
      // Overall timeout (SIGKILL, stderr usually empty): the model did not converge in time, which is
      // an incomplete review, not an internal bug.
      if (r.timedOut) {
        throw new ReviewIncompleteError(
          `review exploration timed out after ${Math.round(timeoutMs / 60_000)}min — 模型在时限内没有收尾(不是网关故障;给各阶段设墙钟即可保住部分结果,或换模型档/降轮次上限)`,
          { failureKind: 'timeout' },
        );
      }
      const parsed = parseExecutorError(r.stderr);
      // The sandbox stderr is the only diagnostic for this path.
      deps.log('review-executor 失败(sandbox stderr 尾部)', {
        exitCode: r.exitCode,
        stderrTail: r.stderr.slice(-2000),
        ...(parsed?.failureKind ? { failureKind: parsed.failureKind } : {}),
        ...(parsed?.failureDetail ? { failureDetail: parsed.failureDetail } : {}),
      });
      // Rebuild the error with its failureKind so classifyJobError picks the right backoff.
      if (parsed?.name === 'ReviewIncompleteError') {
        throw new ReviewIncompleteError(
          parsed.error ?? 'review exploration incomplete (sandbox)',
          {
            ...(parsed.failureKind ? { failureKind: parsed.failureKind as StreamFailureKind } : {}),
            ...(parsed.failureDetail ? { failureDetail: parsed.failureDetail } : {}),
            // Without it the control plane retries a wall-clock cut that will just be cut again.
            ...(parsed.deadlineCut === true ? { deadlineCut: true } : {}),
          },
        );
      }
      throw new Error(
        `review-executor 失败(exit=${r.exitCode}): ${parsed?.error ?? r.stderr.slice(-500)}`,
      );
    }
    const out = await deps.sandbox.getArtifact(handle, OUTPUT);
    return JSON.parse(out.content) as ReviewExecutorOutput;
  } finally {
    if (poll) clearInterval(poll);
    if (cancelPoll) clearInterval(cancelPoll);
    await grant?.close();
    // Relay spans even on failure; Langfuse export happens here so its keys stay on the control plane.
    if (otlpEndpoint || langfuse) {
      const spans = await deps.sandbox.getArtifact(handle, SPANS).catch(() => undefined);
      if (spans?.content) {
        if (otlpEndpoint) {
          const relayed = await relayOtlpFile(spans.content, otlpEndpoint);
          if (relayed.failed > 0 || relayed.dropped > 0) deps.log('review sandbox spans relay', relayed);
        }
        if (langfuse) {
          const relayed = await relayOtlpFile(spans.content, langfuse.endpoint, 15_000, langfuse.headers);
          if (relayed.failed > 0 || relayed.dropped > 0) deps.log('review sandbox spans relay (langfuse)', relayed);
        }
      }
    }
    try {
      await deps.sandbox.destroy(handle);
      // Unregister only on success, so SIGTERM gets another chance at a container that is still alive.
      activeSandboxes.delete(handle.id);
    } catch (error) {
      deps.log('review sandbox cleanup failed', {
        container: handle.containerId,
        error: (error as Error)?.message,
      });
    }
  }
}

/** Last stderr line written by review-executor on failure (apps/review-executor/src/index.ts). */
interface ExecutorErrorLine {
  error?: string;
  name?: string;
  failureKind?: string;
  failureDetail?: string;
  deadlineCut?: boolean;
}

function parseExecutorError(
  stderr: string,
): ExecutorErrorLine | null {
  const line = stderr.trim().split('\n').pop();
  if (!line) return null;
  try {
    return JSON.parse(line) as ExecutorErrorLine;
  } catch {
    return null;
  }
}
