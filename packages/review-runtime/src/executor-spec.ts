import { isStageStrategy, pickStageModelIndex } from '@reviewbot/domain';
import {
  buildKnowledgeTools,
  buildMemoryTools,
  type KnowledgeToolEntry,
  createModelSource,
  type AgentBudget,
  type ModelSourceConfig,
} from '@reviewbot/agent-pi';
import { WorkspaceSourceProvider, type ChangedFileEntry } from '@reviewbot/code-intel';
import {
  resolvePluginTools,
  type PluginName,
  type PluginRelay,
  type PluginToolCallEvent,
  type PluginsConfig,
  type RelayedPlugin,
} from '@reviewbot/plugins';
import type {
  DedupStrategy,
  ExplorationScope,
  ProducedReview,
  ReviewOrchestratorDeps,
  SubmoduleBump,
} from '@reviewbot/review-orchestrator';
import {
  createEmbeddingDeduper,
  createLlmDeduper,
  createOpenAICompatibleEmbed,
} from '@reviewbot/review-orchestrator';
import type { LlmTraceContext } from '@reviewbot/telemetry';

/**
 * Serializable input of the sandbox review executor, which rebuilds its closures from it. The sandbox
 * has no DB or env, so everything the review needs must travel here. Keys are replaced by relay
 * tokens (`relayExecutorSpec`) before the spec leaves the control plane.
 */
export interface ReviewExecutorSpec {
  revisionSha: string;
  /** Seeds stage-model picks; must match the control plane's seed or `random` picks diverge. */
  revisionId: string;
  /** Already path-filtered. */
  changedFiles: ChangedFileEntry[];
  headChangedLines: Record<string, number[]>;
  model: ModelSourceConfig;
  fallbackModels?: ModelSourceConfig[];
  budget: AgentBudget;
  /** Platform keys must be included: without them key-requiring plugins silently do not load. */
  plugins?: {
    config: PluginsConfig;
    credentials?: Partial<Record<PluginName, string>>;
    platformEnv?: Record<string, string>;
    /** Keyed plugins through the platform's relay (`relayExecutorSpec`): no key enters the sandbox. */
    relays?: Partial<Record<RelayedPlugin, PluginRelay>>;
  };
  memoryEntries?: {
    id: string;
    kind: string;
    title: string;
    summary: string;
    body: string;
    links?: string[];
  }[];
  /** Full text of long rules / fact details listed in short form. */
  knowledgeEntries?: KnowledgeToolEntry[];
  changeSummary?: string;
  knowledgeContext?: string;
  /** Already fenced (see repo-guidance.ts). */
  repositoryGuidance?: string;
  lfsPointerPaths?: string[];
  submoduleBumps?: SubmoduleBump[];
  securityEvidence?: string;
  memoryContext?: string;
  ecosystemFacts?: string;
  /** Already wrapped as untrusted data. */
  imageContext?: string;
  collectMemories?: boolean;
  exploration?: ExplorationScope;
  language?: string;
  digConcurrency?: number;
  verifyConcurrency?: number;
  verifyVotes?: number;
  stageBudgetMs?: { map?: number; dig?: number; synthesis?: number };
  verifyBudgetMs?: number;
  /** Changed files not yet explored by any round; scopes touching them run first. */
  uncoveredPaths?: string[];
  /** Unchanged files reviewed under the same contract; readable as context but not review targets. */
  priorReviewedPaths?: string[];
  /** Plan for small changes; the sandbox then skips the LLM map. */
  plannedScopes?: ReviewOrchestratorDeps['plannedScopes'];
  fileContext?: ReviewOrchestratorDeps['fileContext'];
  filePatches?: ReviewOrchestratorDeps['filePatches'];
  /** Loaded by the control plane; the sandbox reads no skill files. */
  skills?: ReviewOrchestratorDeps['skills'];
  reviewFileStates?: { path: string; materialDigest: string }[];
  reviewContractDigest?: string;
  /** Control-plane prompt identities; the executor rejects a mismatched image. */
  promptDigests: { role: string; digest: string }[];
  /** Forks the map transcript into each dig so the shared prefix hits the prompt cache. */
  digForkFromMap?: boolean;
  /** Concurrency of dig's `investigate` tool; absent = no such tool. */
  subagentFanout?: number;
  /**
   * Per-review cost cap (USD). Spread properties escape excess-property checks, so a field missing
   * here is silently dropped at runtime; keep this interface in sync with what env.ts sends.
   */
  costCapUsd?: number;
  /** Serialized pre-verification deduplication mode; omitting it means token-Dice. */
  dedup?:
    | { kind: 'llm' }
    | { kind: 'embedding'; baseUrl: string; apiKey: string; model: string; threshold?: number };
  stageModels?: { stage: string; strategy: string; models: ModelSourceConfig[] }[];
  /** Merges map+dig into one session and forks verify/refute from it (REVIEW_SESSION_REUSE). */
  sessionReuse?: boolean;
  /** Absent = no telemetry inside the sandbox. */
  telemetry?: {
    /** Must be on the squid egress allowlist. */
    langfuseEndpoint?: string;
    langfusePublicKey?: string;
    langfuseSecretKey?: string;
    /** The tenant id here is what tenant erasure uses to locate traces. */
    trace?: LlmTraceContext;
    /** W3C context of the control-plane job span, so sandbox spans join the same trace. */
    traceCarrier?: Record<string, string>;
  };
}

/** The executor was built from different prompts than the control plane (an older or newer image). */
export class PromptDigestMismatchError extends Error {
  override readonly name = 'PromptDigestMismatchError';
}

export function assertPromptDigestParity(
  promptDigests: ReviewExecutorSpec['promptDigests'] | undefined,
  bundles: readonly { role: string; digest: string }[],
): void {
  if (!promptDigests) throw new PromptDigestMismatchError('review executor prompt digests are required');
  const expected = new Map(promptDigests.map((bundle) => [bundle.role, bundle.digest]));
  if (expected.size !== bundles.length) {
    throw new PromptDigestMismatchError('review executor prompt digest set does not match the loaded bundles');
  }
  for (const bundle of bundles) {
    if (expected.get(bundle.role) !== bundle.digest) {
      throw new PromptDigestMismatchError(`review executor prompt mismatch for ${bundle.role}`);
    }
  }
}

/** Recorded in the sandbox; the control plane writes audit events and billing from it. */
export type PluginCallRecord = PluginToolCallEvent;

/** Rebuilds produceReview deps from a spec; publish-only fields are stubs produceReview never touches. */
export function buildProduceDeps(input: {
  spec: ReviewExecutorSpec;
  worktreePath: string;
  bundles: ReviewOrchestratorDeps['bundles'];
  newId: () => string;
  onProgress?: ReviewOrchestratorDeps['onProgress'];
  /** Reads the cancellation sentinel file the control plane writes; absent = not cancellable. */
  isCancelled?: ReviewOrchestratorDeps['isCancelled'];
}): { deps: ReviewOrchestratorDeps; pluginCalls: PluginCallRecord[] } {
  const { spec, worktreePath, bundles, newId } = input;

  const source = new WorkspaceSourceProvider(worktreePath, spec.changedFiles);
  const changedLineSets = new Map<string, Set<number>>(
    Object.entries(spec.headChangedLines).map(([p, ls]) => [p, new Set(ls)]),
  );
  const isChangedLine = (path: string, line: number): boolean =>
    changedLineSets.get(path)?.has(line) ?? false;
  const readHeadLines = async (path: string): Promise<string[]> =>
    (await source.readFile(path))?.split('\n') ?? [];

  const model = createModelSource(spec.model);
  // An invalid fallback config is skipped instead of failing the run.
  const fallbackModels = (spec.fallbackModels ?? [])
    .map((c) => {
      try {
        return createModelSource(c).model;
      } catch {
        return null;
      }
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  const pluginCalls: PluginCallRecord[] = [];
  const plugins = spec.plugins
    ? resolvePluginTools({
        plugins: spec.plugins.config,
        ...(spec.plugins.credentials ? { credentials: spec.plugins.credentials } : {}),
        env: spec.plugins.platformEnv ?? {},
        ...(spec.plugins.relays ? { relays: spec.plugins.relays } : {}),
        onToolCall: (e) => {
          pluginCalls.push(e);
        },
      })
    : undefined;

  const memoryTools =
    spec.memoryEntries && spec.memoryEntries.length > 0
      ? buildMemoryTools(spec.memoryEntries.map((e) => ({ ...e, links: e.links ?? [] })))
      : undefined;
  const knowledgeTools = buildKnowledgeTools(spec.knowledgeEntries ?? []);

  // Must pick with the same pure function as the control plane, or the two sides diverge.
  const stageResolvers = new Map<
    string,
    {
      strategy: string;
      picks: {
        model: ReturnType<typeof createModelSource>['model'];
        streamFn: ReturnType<typeof createModelSource>['streamFn'];
        fallbackModels?: ReturnType<typeof createModelSource>['model'][];
      }[];
    }
  >();
  for (const st of spec.stageModels ?? []) {
    const sources = st.models.flatMap((config) => {
      try {
        return [createModelSource(config)];
      } catch {
        return [];
      }
    });
    if (sources.length === 0) continue;
    stageResolvers.set(st.stage, {
      strategy: st.strategy,
      picks: sources.map((source, i) => {
        const rest = sources.filter((_, j) => j !== i).map((candidate) => candidate.model);
        return {
          model: source.model,
          streamFn: source.streamFn,
          ...(rest.length > 0 ? { fallbackModels: rest } : {}),
        };
      }),
    });
  }
  let dedupStrategy: DedupStrategy | undefined;
  if (spec.dedup?.kind === 'llm') {
    dedupStrategy = createLlmDeduper({
      model: model.model,
      streamFn: model.streamFn,
      budget: spec.budget,
    });
  } else if (spec.dedup?.kind === 'embedding') {
    const { baseUrl, apiKey, model: embeddingModel, threshold } = spec.dedup;
    dedupStrategy = createEmbeddingDeduper({
      embed: createOpenAICompatibleEmbed({ baseUrl, apiKey, model: embeddingModel }),
      ...(threshold !== undefined ? { threshold } : {}),
    });
  }

  const deps: ReviewOrchestratorDeps = {
    source,
    model: model.model,
    ...(stageResolvers.size > 0
      ? {
          stageModel: (stage: string, unitIndex: number) => {
            const r = stageResolvers.get(stage);
            if (!r) return undefined;
            return r.picks[
              pickStageModelIndex(
                r.picks.length,
                isStageStrategy(r.strategy) ? r.strategy : 'fill-first',
                unitIndex,
                spec.revisionId,
              )
            ];
          },
        }
      : {}),
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
    streamFn: model.streamFn,
    bundles,
    budget: spec.budget,
    newId,
    isChangedLine,
    readHeadLines,
    ...(spec.changeSummary !== undefined ? { changeSummary: spec.changeSummary } : {}),
    ...(spec.knowledgeContext !== undefined ? { knowledgeContext: spec.knowledgeContext } : {}),
    ...(spec.repositoryGuidance !== undefined ? { repositoryGuidance: spec.repositoryGuidance } : {}),
    ...(spec.lfsPointerPaths !== undefined ? { lfsPointerPaths: spec.lfsPointerPaths } : {}),
    ...(spec.submoduleBumps !== undefined ? { submoduleBumps: spec.submoduleBumps } : {}),
    ...(spec.securityEvidence !== undefined ? { securityEvidence: spec.securityEvidence } : {}),
    ...(spec.memoryContext !== undefined ? { memoryContext: spec.memoryContext } : {}),
    ...(spec.ecosystemFacts !== undefined ? { ecosystemFacts: spec.ecosystemFacts } : {}),
    ...(spec.imageContext !== undefined ? { imageContext: spec.imageContext } : {}),
    ...(memoryTools ? { memoryTools } : {}),
    ...(knowledgeTools.length > 0 ? { knowledgeTools } : {}),
    ...(plugins && plugins.tools.length > 0 ? { pluginTools: plugins.tools, lookupSources: plugins.sources } : {}),
    ...(spec.collectMemories !== undefined ? { collectMemories: spec.collectMemories } : {}),
    ...(spec.exploration !== undefined ? { exploration: spec.exploration } : {}),
    ...(spec.language !== undefined ? { language: spec.language } : {}),
    ...(spec.digConcurrency !== undefined ? { digConcurrency: spec.digConcurrency } : {}),
    ...(spec.verifyConcurrency !== undefined ? { verifyConcurrency: spec.verifyConcurrency } : {}),
    ...(spec.verifyVotes !== undefined ? { verifyVotes: spec.verifyVotes } : {}),
    ...(spec.stageBudgetMs !== undefined ? { stageBudgetMs: spec.stageBudgetMs } : {}),
    ...(spec.verifyBudgetMs !== undefined ? { verifyBudgetMs: spec.verifyBudgetMs } : {}),
    ...(spec.uncoveredPaths !== undefined ? { uncoveredPaths: spec.uncoveredPaths } : {}),
    ...(spec.priorReviewedPaths !== undefined
      ? { priorReviewedPaths: spec.priorReviewedPaths }
      : {}),
    ...(spec.plannedScopes !== undefined ? { plannedScopes: spec.plannedScopes } : {}),
    ...(spec.fileContext !== undefined ? { fileContext: spec.fileContext } : {}),
    ...(spec.filePatches !== undefined ? { filePatches: spec.filePatches } : {}),
    ...(spec.skills !== undefined ? { skills: spec.skills } : {}),
    ...(spec.reviewFileStates !== undefined ? { reviewFileStates: spec.reviewFileStates } : {}),
    ...(spec.reviewContractDigest !== undefined
      ? { reviewContractDigest: spec.reviewContractDigest }
      : {}),
    ...(spec.digForkFromMap ? { digForkFromMap: true } : {}),
    // Subagents get half the parent budget, so fanning out does not multiply the run's budget.
    ...(spec.subagentFanout && spec.subagentFanout > 1
      ? {
          subagents: {
            maxTasks: spec.subagentFanout,
            maxConcurrency: spec.subagentFanout,
            budget: {
              maxTurns: Math.max(4, Math.floor(spec.budget.maxTurns / 2)),
              maxToolCalls: Math.max(4, Math.floor(spec.budget.maxToolCalls / 2)),
            },
          },
        }
      : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.isCancelled ? { isCancelled: input.isCancelled } : {}),
    ...(spec.costCapUsd !== undefined ? { costCapUsd: spec.costCapUsd } : {}),
    ...(dedupStrategy ? { dedupStrategy } : {}),
    ...(spec.sessionReuse !== undefined ? { sessionReuse: spec.sessionReuse } : {}),
    noiseBudget: {
      maxInlineComments: Number.MAX_SAFE_INTEGER,
      maxInlinePerFile: Number.MAX_SAFE_INTEGER,
      maxInlineNits: Number.MAX_SAFE_INTEGER,
    },
    publishContext: {} as ReviewOrchestratorDeps['publishContext'],
    publishTarget: {
      tenantId: '',
      repositoryId: '',
      changeRequest: { id: '', repositoryId: '', nativeId: '', number: 0, kind: 'pull-request' },
      changeRequestId: '',
      revisionId: '',
      revisionSha: spec.revisionSha,
      providerHostId: '',
      expectedHeadSha: spec.revisionSha,
    },
  };
  return { deps, pluginCalls };
}

export interface ReviewExecutorOutput {
  produced: ProducedReview;
  pluginCalls: PluginCallRecord[];
}
