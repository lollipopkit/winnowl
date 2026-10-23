import type { AgentTool } from '@reviewbot/agent-pi';
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

export interface RunExecutorInput {
  spec: ReviewExecutorSpec;
  worktreePath: string;
  /** Fire-and-forget: reporting must never slow or fail the main path. */
  onProgress: (p: ReviewProgress) => void;
  /** Checked before each billable step; a cancelled run still returns its output so usage is billed. */
  isCancelled: () => boolean;
  /** Where spans go when the collector is unreachable (sandbox); the control plane relays them. */
  spansPath?: string;
  commandTools?: AgentTool[];
}

/** exploration + verification of one review, shared by the sandbox and GitHub Actions entries. */
export async function runExecutor(input: RunExecutorInput): Promise<ReviewExecutorOutput> {
  const { spec } = input;
  const loaded = await loadPromptBundles(['mapper', 'reviewer', 'synthesizer', 'verifier', 'refuter']);
  const bundles = {
    mapper: loaded.mapper as PromptBundle,
    reviewer: loaded.reviewer as PromptBundle,
    synthesizer: loaded.synthesizer as PromptBundle,
    verifier: loaded.verifier as PromptBundle,
    refuter: loaded.refuter as PromptBundle,
  };
  assertPromptDigestParity(spec.promptDigests, Object.values(bundles));

  // Without a relay (local) Langfuse config comes in the spec and exports directly.
  const telemetry =
    input.spansPath || spec.telemetry?.langfuseEndpoint
      ? initTelemetry({
          serviceName: 'winnowl-review-executor',
          ...(input.spansPath ? { spanFile: input.spansPath } : {}),
          ...(spec.telemetry?.langfuseEndpoint ? { langfuseEndpoint: spec.telemetry.langfuseEndpoint } : {}),
          ...(spec.telemetry?.langfusePublicKey ? { langfusePublicKey: spec.telemetry.langfusePublicKey } : {}),
          ...(spec.telemetry?.langfuseSecretKey ? { langfuseSecretKey: spec.telemetry.langfuseSecretKey } : {}),
        })
      : undefined;

  try {
    const { deps, pluginCalls } = buildProduceDeps({
      spec,
      worktreePath: input.worktreePath,
      bundles,
      newId: () => uuidv7(),
      onProgress: input.onProgress,
      isCancelled: input.isCancelled,
      ...(input.commandTools ? { commandTools: input.commandTools } : {}),
    });
    // Parented to the control plane's job span; every LLM call carries tenant/repo/PR context.
    const produced = await withRemoteTraceCarrier(spec.telemetry?.traceCarrier, () =>
      withLlmTraceContext(spec.telemetry?.trace ?? {}, () => produceReview(deps)),
    );
    return { produced, pluginCalls };
  } finally {
    // BatchSpanProcessor exports asynchronously; without a flush the process exits and spans are silently lost.
    await telemetry?.forceFlush().catch(() => undefined);
    await telemetry?.shutdown().catch(() => undefined);
  }
}
