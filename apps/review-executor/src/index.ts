import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { uuidv7 } from '@reviewbot/ids';
import { loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import { produceReview, type ReviewProgress } from '@reviewbot/review-orchestrator';
import {
  assertPromptDigestParity,
  buildProduceDeps,
  type ReviewExecutorOutput,
  type ReviewExecutorSpec,
} from '@reviewbot/review-runtime';
import { initTelemetry, withLlmTraceContext, withRemoteTraceCarrier } from '@reviewbot/telemetry';

// All fetches go through the egress squid (relay + allowlisted hosts only); must be set before any fetch.
const egressProxy = process.env.SANDBOX_EGRESS_PROXY;
if (egressProxy) {
  setGlobalDispatcher(new ProxyAgent(egressProxy));
}

/**
 * Batch program run inside the review sandbox (no secrets, read-only rootfs, locked network): reads
 * the spec and worktree, runs produceReview, writes the result. On sandbox hosts the spec carries
 * relay tokens instead of keys; the control plane publishes the result.
 */
async function main(): Promise<void> {
  const inputPath = process.env.INPUT_PATH ?? process.argv[2];
  const outputPath = process.env.OUTPUT_PATH ?? process.argv[3];
  const worktreePath = process.env.WORKTREE_PATH ?? process.argv[4];
  if (!inputPath || !outputPath || !worktreePath) {
    throw new Error(
      'review-executor 需 INPUT_PATH / OUTPUT_PATH / WORKTREE_PATH(env 或 argv[2..4])',
    );
  }

  const spec = JSON.parse(await readFile(inputPath, 'utf8')) as ReviewExecutorSpec;

  const loaded = await loadPromptBundles([
    'mapper',
    'reviewer',
    'synthesizer',
    'verifier',
    'refuter',
  ]);
  const bundles = {
    mapper: loaded.mapper as PromptBundle,
    reviewer: loaded.reviewer as PromptBundle,
    synthesizer: loaded.synthesizer as PromptBundle,
    verifier: loaded.verifier as PromptBundle,
    refuter: loaded.refuter as PromptBundle,
  };
  assertPromptDigestParity(spec.promptDigests, Object.values(bundles));

  // The trace collector is unreachable from the sandbox, so spans go to SPANS_PATH for the control
  // plane to forward; without a relay (local) Langfuse config comes in the spec and exports directly.
  const spansPath = process.env.SPANS_PATH;
  const telemetry =
    spansPath || spec.telemetry?.langfuseEndpoint
      ? initTelemetry({
          serviceName: 'winnowl-review-executor',
          ...(spansPath ? { spanFile: spansPath } : {}),
          ...(spec.telemetry?.langfuseEndpoint ? { langfuseEndpoint: spec.telemetry.langfuseEndpoint } : {}),
          ...(spec.telemetry?.langfusePublicKey ? { langfusePublicKey: spec.telemetry.langfusePublicKey } : {}),
          ...(spec.telemetry?.langfuseSecretKey ? { langfuseSecretKey: spec.telemetry.langfuseSecretKey } : {}),
        })
      : undefined;

  // Progress goes to a file the control plane polls via `docker exec cat`; write-then-rename keeps
  // reads atomic. Fire-and-forget: reporting must never slow or fail the main path.
  const progressPath = process.env.PROGRESS_PATH ?? '/workspace/progress.json';
  const writeProgress = (p: ReviewProgress): void => {
    const tmp = `${progressPath}.tmp`;
    void writeFile(tmp, JSON.stringify({ ...p, at: new Date().toISOString() }), 'utf8')
      .then(() => rename(tmp, progressPath))
      .catch(() => undefined);
  };

  // The control plane signals cancellation with a sentinel file, checked before each billable step.
  // A cancelled run still writes its output: usage so far is billed.
  const cancelPath = process.env.CANCEL_PATH ?? '/workspace/cancel';
  const isCancelled = (): boolean => existsSync(cancelPath);

  try {
    const { deps, pluginCalls } = buildProduceDeps({
      spec,
      worktreePath,
      bundles,
      newId: () => uuidv7(),
      onProgress: writeProgress,
      isCancelled,
    });
    // Parented to the control plane's job span; every LLM call carries tenant/repo/PR context.
    const produced = await withRemoteTraceCarrier(spec.telemetry?.traceCarrier, () =>
      withLlmTraceContext(spec.telemetry?.trace ?? {}, () => produceReview(deps)),
    );

    const output: ReviewExecutorOutput = { produced, pluginCalls };
    await writeFile(outputPath, JSON.stringify(output), 'utf8');
  } finally {
    // BatchSpanProcessor exports asynchronously; without a flush the process exits and spans are silently lost.
    await telemetry?.forceFlush().catch(() => undefined);
    await telemetry?.shutdown().catch(() => undefined);
  }
}

main().catch((err) => {
  // The control plane classifies failures from stderr; failureKind picks its retry backoff.
  const e = err as {
    message?: string;
    name?: string;
    failureKind?: string;
    failureDetail?: string;
    deadlineCut?: boolean;
  };
  process.stderr.write(
    JSON.stringify({
      error: e?.message,
      name: e?.name,
      ...(e?.failureKind ? { failureKind: e.failureKind } : {}),
      ...(e?.failureDetail ? { failureDetail: e.failureDetail } : {}),
      // Wall clock expired with zero candidates: the control plane must not retry it.
      ...(e?.deadlineCut === true ? { deadlineCut: true } : {}),
    }) + '\n',
  );
  process.exit(1);
});
