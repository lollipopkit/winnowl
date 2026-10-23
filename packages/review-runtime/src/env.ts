import { isStageStrategy, pickStageModelIndex } from '@reviewbot/domain';
import { describePrImages } from './vlm.js';
import type { FetchedImage } from './pr-images.js';
import {
  assertModelEndpointAllowed,
  buildKnowledgeTools,
  buildMemoryTools,
  type KnowledgeToolEntry,
  createModelSource,
  type AgentBudget,
  type AgentTool,
  type Model,
  type ModelMetadata,
  type ModelSourceConfig,
  type ModelSelector,
  type StreamFn,
  type ModelTier,
  type SourceProvider,
} from '@reviewbot/agent-pi';
import { classifyChangeRisk, computeRiskFactor } from '@reviewbot/cost-budget';
import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import {
  detectCrossRepoTriggers,
  evaluateCrossRepoAccess,
  loadActiveCrossTenantForSource,
  loadEnabledRelationships,
  recordCrossTenantEvent,
} from '@reviewbot/multi-repo';
import {
  loadActiveFindings,
  loadChangeRequestBlockingFindings,
  loadDismissedFindings,
  semanticFingerprint,
  weakFingerprint,
} from '@reviewbot/finding-lifecycle';
import {
  buildMemoryIndex,
  collectAuthoritativeRules,
  listAgentMemories,
  loadApplicableKnowledge,
  markLearningsUsed,
  orderKnowledgeForPaths,
  type RawAuthoritativeRule,
  type RetrievalItem,
} from '@reviewbot/knowledge';
import type { PublishContext } from '@reviewbot/publisher';
import {
  createEmbeddingDeduper,
  createLlmDeduper,
  createLlmFindingMatcher,
  createOpenAICompatibleEmbed,
  type DedupStrategy,
  type DependencyFindingInput,
  type FindingMatcherDeps,
  type CarriedFinding,
  type MatchPrior,
  type OpenPriorFinding,
  type OrchestratorStageModelResolver,
  type ReviewOrchestratorDeps,
  type StaleCandidate,
} from '@reviewbot/review-orchestrator';
import {
  loadOrganizationLayer,
  loadPanelLayer,
  persistEffectiveConfig,
  platformSetting,
  readPlatformSettings,
  resolvePlatformSetting,
  type ConfigLayer,
} from '@reviewbot/config';
import { masterKeyFromEnv } from '@reviewbot/kms';
import { currentLlmTraceContext, currentTraceCarrier, recordPluginCall } from '@reviewbot/telemetry';
import {
  BYOK_PROVIDERS,
  platformPluginEnv,
  byokModelSpec,
  pluginCallCostUsd,
  recordByokOutcome,
  resolveByok,
  resolvePluginTools,
  type ByokFallbackReason,
  resolveServiceCredentials,
  type PluginToolCallEvent,
} from '@reviewbot/plugins';
import {
  loadRepoConfigFromReader,
  loadedConfigFromLayers,
  type LoadedRepoConfig,
} from './config.js';
import { CodePlaneReader, type CodePlane } from './code-plane.js';
import { applyPathFilter, submoduleBumpsOf } from './path-filter.js';
import { PATCH_MAX_CHARS_PER_FILE, PATCH_MAX_TOTAL_CHARS } from './workspace.js';
import { stackRootBranchOf } from './trusted-base.js';
import { hasReviewableContent, pickReviewRound } from './review-round.js';
import { loadRepositoryGuidance, renderRepositoryGuidance } from './repo-guidance.js';
import { ecosystemFactsFor } from './ecosystem-facts.js';
import { ruleLine } from './knowledge-inline.js';
import { selectKnowledge } from './knowledge-select.js';
import type { ReviewExecutorSpec } from './executor-spec.js';
import { buildReviewContractDigest, type ReviewFileState } from './file-state.js';
import { filesWithStaleDependencies, partitionReviewFiles } from './pr-coverage.js';
import type { ReviewSkill } from '@reviewbot/prompts';
import { mergeSkills, skillStandardLine } from './skills.js';
import { locatePinLine } from './dependency-pin.js';

export type ReviewEnv = Omit<ReviewOrchestratorDeps, 'publishTarget' | 'newId'> & {
  /** Releases this review's workspace; the caller must call it after its own review finishes (in finally). */
  disposeWorkspace: () => Promise<void>;
  /** Serializable executor spec (real models only); the handler uses it to run in a sandbox or in-process. */
  executorSpec?: ReviewExecutorSpec;
  /** This review's workspace: where sandboxes run and how the head worktree reaches them. */
  codePlane: CodePlane;
  /** Guidance files read this round and those rejected for injection patterns, for logging. */
  guidanceReport?: { files: string[]; rejected: { path: string; patterns: string[] }[] };
  /** Replays plugin calls made inside the sandbox (recorded in memory only) into audit_events and metering. */
  onPluginCall?: (event: PluginToolCallEvent) => Promise<void>;
  /** `sandbox.runner` as read for this review (not the stored mirror, which lags one review). */
  runner: 'platform' | 'actions';
};

export interface ModelSource {
  model: Model<string>;
  streamFn: StreamFn;
  /** Resolved config, used to rebuild streamFn inside the executor; omitted for faux models. */
  config?: ModelSourceConfig;
}

function coerceModelTier(v: string | undefined): ModelTier | undefined {
  return v === 'quality' || v === 'balanced' || v === 'cheap' ? v : undefined;
}

/**
 * Regions reviewed concurrently. Total parallelism multiplies:
 * RUNNER_CONCURRENCY x review.dig_concurrency x review.subagents. Subagents shorten a single region's
 * dig (one wall-clock budget); extra regions only wait together, so parallelism goes to subagents.
 */
const DIG_CONCURRENCY_DEFAULT = 2;

/** Stage wall-clock setting (minutes, `off` = unlimited) to ms; 0 = no limit. */
function stageBudgetMs(setting: string | undefined): number {
  if (setting === undefined || setting === 'off') return 0;
  const minutes = Number(setting);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0;
}

export function resolveDedupStrategy(
  model: ModelSource,
  budget: AgentBudget,
  env: NodeJS.ProcessEnv = process.env,
  /** Effective platform setting (DB first); falls back to env when omitted. */
  override?: string,
): DedupStrategy | undefined {
  const mode = (override ?? env.LLM_DEDUP ?? 'token').trim().toLowerCase();
  if (mode === '' || mode === 'token') return undefined;
  if (mode === 'llm')
    return createLlmDeduper({ model: model.model, streamFn: model.streamFn, budget });
  if (mode === 'embedding') {
    const baseUrl = env.LLM_BASE_URL;
    const apiKey = env.LLM_API_KEY;
    const embedModel = env.LLM_EMBED_MODEL;
    if (!baseUrl || !apiKey || !embedModel) {
      throw new Error(
        'LLM_DEDUP=embedding 需 LLM_BASE_URL + LLM_API_KEY + LLM_EMBED_MODEL(OpenAI 兼容 /embeddings)',
      );
    }
    // The embedding endpoint must also pass the ZDR allowlist (fail-closed).
    assertModelEndpointAllowed({ provider: env.LLM_PROVIDER ?? '', baseUrl }, env);
    const t = Number(env.LLM_DEDUP_THRESHOLD);
    return createEmbeddingDeduper({
      embed: createOpenAICompatibleEmbed({ baseUrl, apiKey, model: embedModel }),
      ...(Number.isFinite(t) && t > 0 ? { threshold: t } : {}),
    });
  }
  throw new Error(`未知 LLM_DEDUP="${mode}"(应为 token|embedding|llm)`);
}

function resolveExecutorDedupSpec(
  env: NodeJS.ProcessEnv,
  override: string | undefined,
): ReviewExecutorSpec['dedup'] | undefined {
  const mode = (override ?? env.LLM_DEDUP ?? 'token').trim().toLowerCase();
  if (mode === '' || mode === 'token') return undefined;
  if (mode === 'llm') return { kind: 'llm' };
  if (mode === 'embedding') {
    const baseUrl = env.LLM_BASE_URL;
    const apiKey = env.LLM_API_KEY;
    const model = env.LLM_EMBED_MODEL;
    if (!baseUrl || !apiKey || !model) {
      throw new Error(
        'LLM_DEDUP=embedding requires LLM_BASE_URL, LLM_API_KEY, and LLM_EMBED_MODEL',
      );
    }
    const threshold = Number(env.LLM_DEDUP_THRESHOLD);
    return {
      kind: 'embedding',
      baseUrl,
      apiKey,
      model,
      ...(Number.isFinite(threshold) && threshold > 0 ? { threshold } : {}),
    };
  }
  throw new Error(`unknown LLM_DEDUP="${mode}" (expected token|embedding|llm)`);
}

/**
 * Cross-round finding identity matcher (`REVIEW_FINDING_MATCH`: `llm` default, `off` = exact strong
 * fingerprint). Separate from `LLM_DEDUP` because a wrong match here silences a real finding or flips
 * the gate. On by default: fingerprints drift across rounds and token-Dice returns 0 for CJK claims.
 */
export function resolveFindingMatcher(
  model: ModelSource,
  env: NodeJS.ProcessEnv = process.env,
  /** Effective platform setting (DB first); falls back to env when omitted. */
  override?: string,
): Omit<FindingMatcherDeps, 'budget'> | undefined {
  const mode = (override ?? env.REVIEW_FINDING_MATCH ?? 'llm').trim().toLowerCase();
  if (mode === '' || mode === 'off') return undefined;
  if (mode !== 'llm') throw new Error(`未知 REVIEW_FINDING_MATCH="${mode}"(应为 off|llm)`);
  const maxItems = Number(env.REVIEW_FINDING_MATCH_MAX_ITEMS);
  return {
    model: model.model,
    streamFn: model.streamFn,
    fastPath: env.REVIEW_FINDING_MATCH_FAST_PATH === '1',
    ...(Number.isFinite(maxItems) && maxItems > 0 ? { maxItems } : {}),
  };
}

export interface RuntimeCtx {
  payload: {
    revisionId: string;
    tenantId?: string;
    repositoryId?: string;
    /**
     * Platform user who started the run, for user-level BYOK (user > repo > org); set only for console-triggered runs.
     * TODO: link webhook provider actors to platform users so webhook runs set it too.
     */
    initiatedByUserId?: string;
    changeRequestId?: string;
    forceFullReview?: boolean;
  };
  db: Db;
  /** Set to 'byok' by buildEnv when a BYOK model is resolved; read by review cost metering. */
  modelSourceKind?: 'platform' | 'byok';
}

export type PublishDiscussions = PublishContext['discussions'];

/** A stage's models and allocation strategy (structurally matches entitlement's `StageModelPlan`). */
export interface StageModelSpec {
  stage: string;
  /** fill-first | round-robin | random; unknown values fall back to fill-first. */
  strategy: string;
  /** Metadata travels with the identity because the sandbox has no DB to look it up. */
  models: {
    provider: string;
    modelId: string;
    metadata?: ModelMetadata;
  }[];
}

export interface CreateBuildEnvDeps {
  bundles: ReviewEnv['bundles'];
  /** Built-in skills; repository skills are read from the trusted base commit. */
  skills?: readonly ReviewSkill[];
  /** Opens this review's workspace (sandbox host or in-process); the control plane reads code only through it. */
  openWorkspace: (
    ctx: RuntimeCtx,
    revision: { changeRequestId: string; baseSha: string; headSha: string; stackRootBranch?: string },
  ) => Promise<CodePlane>;
  buildDiscussions: (ctx: RuntimeCtx) => Promise<PublishDiscussions> | PublishDiscussions;
  /** Provider's current CR head, used to reject a stale revision before publishing; defaults to the workspace head. */
  fetchCurrentHeadSha?: (ctx: RuntimeCtx) => Promise<string>;
  /** Upserts the summary into the CR description; undefined = unsupported, the summary goes to a comment instead. */
  buildDescriptionUpdater?: (
    ctx: RuntimeCtx,
  ) => Promise<((summaryMarkdown: string) => Promise<void>) | undefined>;
  modelSource: (selector?: ModelSelector) => ModelSource | Promise<ModelSource>;
  /** Per-tenant model selector from the plan; overrides env `LLM_MODEL_TIER` when it returns a value. */
  resolveModelSelector?: (ctx: RuntimeCtx) => Promise<ModelSelector | undefined>;
  /**
   * Per-run cost cap from the tenant plan (`0` = unlimited); undefined falls back to env `REVIEW_COST_CAP_USD`.
   * The plan wins so the env cap (meant for external tenants) does not truncate internal tenants' reviews.
   */
  resolveReviewCostCapUsd?: (ctx: RuntimeCtx) => Promise<number | undefined>;
  /** Per-stage models; omitted/empty = the effective model throughout. Typed structurally to avoid a billing package dependency. */
  resolveStageModels?: (ctx: RuntimeCtx) => Promise<StageModelSpec[] | undefined>;
  /** Fetches images from the CR body/comments; lives in the caller because the allowlist depends on the provider origin. */
  fetchChangeRequestImages?: (ctx: RuntimeCtx) => Promise<FetchedImage[]>;
  /**
   * Other models of the same tier (excluding the effective one), in preference order; tried when the primary
   * fails for a non-rate-limit reason after retries. Intentionally empty for BYOK and overage downgrade.
   */
  resolveFallbackModelSelectors?: (ctx: RuntimeCtx) => Promise<ModelSelector[]>;
  changeSummary?: string;
  /** Bot @mention (e.g. `@winnowl`); when set, the summary includes an "ask the bot to fix" hint. */
  botMention?: string;
  /**
   * Enqueues cross-repo analysis when a contract change has an active relationship and the producer enables
   * `cross_repo.analyze.enabled`. Omitted = audit only.
   */
  onCrossRepoImpact?: (impact: CrossRepoImpact) => Promise<void>;
  /**
   * Deterministic dependency vulnerability scan (reads lock files, never runs repo code) when manifests/locks
   * change. Findings are synthesized directly, not via the LLM, because verify rejects paraphrased ones.
   * Omitted = no scan.
   */
  scanDependencies?: (input: {
    workspace: CodePlane;
    changedFiles: string[];
    language?: string;
  }) => Promise<DependencyScanOutcome | undefined>;
}

/** A vulnerability returned by the scan callback; `claim` is already localized. */
export interface ScannedDependencyVulnerability {
  package: string;
  installedVersion?: string;
  severity: DependencyFindingInput['severity'];
  advisoryId: string;
  claim: string;
  /** Source manifest/lock path, used to decide "introduced"; missing = preexisting. */
  manifestPath?: string;
}

export interface DependencyScanOutcome {
  vulnerabilities: ScannedDependencyVulnerability[];
  totalCount: number;
}

/** Cross-repo impact payload; carries contract file head contents so the analysis need not clone the producer. */
export interface CrossRepoImpact {
  tenantId: string;
  sourceRepositoryId: string;
  revisionId: string;
  triggers: { kind: string; files: string[] }[];
  consumers: {
    repositoryId: string;
    relationshipId: string;
    kind: string;
    instructions?: string;
  }[];
  /** Contract file head contents (30KB per file, 100KB total). */
  contractContext: { path: string; headContent: string; truncated: boolean }[];
}

/** Per-file cap (chars) on the between-rounds diff; larger diffs are truncated and marked. */
const ROUND_DIFF_MAX_CHARS = 4000;

const FAST_MAP_MAX_FILES = 3;
const FAST_MAP_MAX_LINES = 120;

/** Single-scope plan that skips map for small changes, where planning costs more than it saves. */
export function plannedScopeFor(paths: string[]): NonNullable<ReviewOrchestratorDeps['plannedScopes']>[number] {
  return {
    title: `Changes in ${paths.join(', ')}`,
    changeSummary: `The changes this pull request makes to ${paths.join(', ')}.`,
    obligations: [
      { kind: 'correctness', description: 'The changed code computes the right result for every input its callers can pass, including edge cases.' },
      { kind: 'error-handling', description: 'Failures are handled or propagated; nothing is silently swallowed or left half-done.' },
      { kind: 'state-invariant', description: 'State stays consistent across the change, including partial failures and repeated calls.' },
      { kind: 'resource-lifetime', description: 'Resources, listeners, timers and caches are released or bounded.' },
      { kind: 'security', description: 'Untrusted input cannot reach sensitive operations unchecked.' },
      { kind: 'compatibility', description: 'Callers of the changed code keep working with the new behaviour and signatures.' },
    ],
    files: paths,
  };
}

export function createReviewBuildEnv(
  deps: CreateBuildEnvDeps,
): (ctx: RuntimeCtx) => Promise<ReviewEnv> {
  /**
   * Each review owns its workspace and releases it via `disposeWorkspace` (concurrent reviews run in one
   * process, so a shared slot would delete a running review's worktree). `register` lets the outer
   * wrapper release it if building fails halfway.
   */
  const build = async (
    ctx: RuntimeCtx,
    register: (dispose: () => Promise<void>) => void,
  ): Promise<ReviewEnv> => {
    // Tenant/panel config fragments; gate fields (plugins.*.enabled, sandbox network mode) take the strictest value.
    // Organization defaults and the console panel; the repository file is read from the trusted commit below.
    const tenantLayers: ConfigLayer[] = [];
    const panelLayer = ctx.payload.repositoryId ? await loadPanelLayer(ctx.db, ctx.payload.repositoryId) : null;
    if (panelLayer) tenantLayers.push(panelLayer);
    const organizationLayer = ctx.payload.tenantId ? await loadOrganizationLayer(ctx.db, ctx.payload.tenantId) : null;
    if (organizationLayer) tenantLayers.push(organizationLayer);

    const rev = await ctx.db
      .selectFrom('revisions')
      .select(['base_sha', 'head_sha', 'change_request_id'])
      .where('id', '=', ctx.payload.revisionId)
      .executeTakeFirstOrThrow();
    // The coverage ledger is keyed by CR (accumulates across revisions).
    const coverageCrId = rev.change_request_id;
    const stackRootBranch = await stackRootBranchOf(ctx.db, rev.change_request_id);
    const plane = await deps.openWorkspace(ctx, {
      changeRequestId: rev.change_request_id,
      baseSha: rev.base_sha,
      headSha: rev.head_sha,
      ...(stackRootBranch !== undefined ? { stackRootBranch } : {}),
    });
    const disposeWorkspace = (): Promise<void> => plane.dispose();
    register(disposeWorkspace);
    const info = plane.info;
    /**
     * Review instructions (`.winnowl.yaml`, AGENTS.md, CLAUDE.md) are read only from the trusted commit,
     * so a PR cannot change how it is reviewed; edits to them take effect after merge.
     */
    const readTrustedFile = (path: string): Promise<string | null> => plane.client.readTrustedFile(path);
    const commitBase = rev.base_sha;
    const reader = new CodePlaneReader(plane);
    let cfg: LoadedRepoConfig = await loadRepoConfigFromReader(readTrustedFile, tenantLayers);
    let wsView: {
      source: SourceProvider;
      readHeadLines: (p: string) => Promise<string[]>;
      isChangedLine: (p: string, line: number) => boolean;
      headSha: string;
      fileStates: ReviewFileState[];
    } = {
      source: reader.source,
      readHeadLines: reader.readHeadLines,
      isChangedLine: reader.isChangedLine,
      headSha: info.headSha,
      fileStates: info.fileStates,
    };
    if (ctx.payload.tenantId && ctx.payload.repositoryId) {
      if (cfg.hasRepoFile) {
        // Repo yaml is authoritative; mirror it for the console and other flows (gate/autofix/chat).
        await persistEffectiveConfig(ctx.db, {
          tenantId: ctx.payload.tenantId,
          repositoryId: ctx.payload.repositoryId,
          settings: cfg.config,
          configDigest: cfg.configDigest,
          ...(cfg.fileSettings ? { fileSettings: cfg.fileSettings } : {}),
        });
      } else {
        // The settings mirror is display-only; a stale mirror must not apply after the yaml is deleted.
        cfg = loadedConfigFromLayers(tenantLayers);
      }
    }
    const discussions = await deps.buildDiscussions(ctx);
    const updateSummaryDescription = deps.buildDescriptionUpdater
      ? await deps.buildDescriptionUpdater(ctx)
      : undefined;

    let priorFingerprints: ReadonlySet<string> | undefined;
    let priorFindings: MatchPrior[] | undefined;
    let activePrior: Awaited<ReturnType<typeof loadActiveFindings>> = [];
    let staleCandidates: StaleCandidate[] | undefined;
    let computeFingerprint: ReviewEnv['computeFingerprint'];
    let computeWeakFingerprint: ReviewEnv['computeWeakFingerprint'];
    let priorBlockingFindings: ReviewEnv['priorBlockingFindings'];
    // Fingerprints ignored via `@bot ignore` on this CR, suppressed before publishing.
    let dismissedFindings: ReviewEnv['dismissedFindings'];
    let stack: ReviewEnv['stack'];
    const revRow = await ctx.db
      .selectFrom('revisions')
      .select('change_request_id')
      .where('id', '=', ctx.payload.revisionId)
      .executeTakeFirst();
    if (revRow) {
      dismissedFindings = await loadDismissedFindings(ctx.db, revRow.change_request_id);
      const crRow = await ctx.db
        .selectFrom('change_requests')
        .select(['stack_position', 'stack_size', 'stack_base_ref', 'stacked_on_change_request_id'])
        .where('id', '=', revRow.change_request_id)
        .executeTakeFirst();
      if (crRow) {
        const parentNumber = crRow.stacked_on_change_request_id
          ? (
              await ctx.db
                .selectFrom('change_requests')
                .select('number')
                .where('id', '=', crRow.stacked_on_change_request_id)
                .executeTakeFirst()
            )?.number
          : undefined;
        const info = {
          ...(crRow.stack_position !== null ? { position: crRow.stack_position } : {}),
          ...(crRow.stack_size !== null ? { size: crRow.stack_size } : {}),
          ...(crRow.stack_base_ref !== null ? { baseRef: crRow.stack_base_ref } : {}),
          ...(parentNumber !== undefined ? { onNumber: parentNumber } : {}),
        };
        if (Object.keys(info).length > 0) stack = info;
      }
    }
    // Console settings win over env; env stays as a rollback path in case the console itself is broken.
    const platformSettings = await readPlatformSettings(ctx.db);
    const settingOf = (key: string): string | undefined =>
      resolvePlatformSetting(key, platformSettings.get(key)).value;
    const positiveIntSetting = (key: string): number | undefined => {
      const n = Number(settingOf(key));
      return Number.isInteger(n) && n > 0 ? n : undefined;
    };
    const digConcurrency = positiveIntSetting('review.dig_concurrency') ?? DIG_CONCURRENCY_DEFAULT;
    const verifyConcurrency = positiveIntSetting('review.verify_concurrency') ?? 8;
    // N votes cost N times the verify spend.
    const verifyVotes = positiveIntSetting('review.verify_votes') ?? 1;

    if (ctx.payload.tenantId && ctx.payload.repositoryId) {
      const repositoryId = ctx.payload.repositoryId;
      computeFingerprint = (input) =>
        semanticFingerprint({
          repositoryId,
          category: input.category,
          claim: input.claim,
          codeWindow: input.primaryAnchorText,
          ...(input.path !== undefined ? { path: input.path } : {}),
        });
      computeWeakFingerprint = (input) =>
        weakFingerprint({
          repositoryId,
          category: input.category,
          codeWindow: input.primaryAnchorText,
          ...(input.path !== undefined ? { path: input.path } : {}),
        });
      // Fingerprints are repo-wide, but history is scoped to this CR so other PRs' findings never gate it.
      if (revRow) {
        const prior = await loadActiveFindings(ctx.db, repositoryId, revRow.change_request_id);
        activePrior = prior;
        priorFingerprints = new Set(prior.map((f) => f.fingerprint));
        // Semantic fields for the matcher; fingerprints miss reworded duplicates.
        priorFindings = prior.map((f) => ({
          findingId: f.id,
          fingerprint: f.fingerprint,
          category: f.category,
          claim: f.claim,
          ...(f.path !== undefined ? { path: f.path } : {}),
          ...(f.anchorText !== undefined ? { codeWindow: f.anchorText } : {}),
        }));
        // Stale candidates by round count only; the remaining checks run in publishReview once this round's findings are known.
        const staleRounds = Number(settingOf('review.stale_rounds'));
        if (Number.isFinite(staleRounds) && staleRounds > 0) {
          staleCandidates = prior
            // Lifecycle is repo-wide but evidence comes from this CR only, so skip findings active elsewhere.
            .filter((f) => f.roundsSinceLastSeen >= staleRounds && !f.seenOnOtherChangeRequests)
            .map((f) => ({
              findingId: f.id,
              fingerprint: f.fingerprint,
              ...(f.path !== undefined ? { path: f.path } : {}),
              ...(f.lastSeenHeadSha !== undefined ? { lastSeenHeadSha: f.lastSeenHeadSha } : {}),
            }));
        }
        // Blocking findings on this CR, reconciled for fixes when not reported again this round.
        const priorBlocking = await loadChangeRequestBlockingFindings(
          ctx.db,
          revRow.change_request_id,
          {
            blockPreexisting: cfg.config.reviews.block_preexisting,
            blockOnSeverity: cfg.config.merge_gate.block_on_severity,
          },
        );
        // "Changed since last seen" must compare against that round's head, not this diff's base..head.
        const priorHeadShas = new Map<string, string>();
        const priorRevisionIds = [...new Set(priorBlocking.map((f) => f.revisionId))];
        if (priorRevisionIds.length > 0) {
          const revRows = await ctx.db
            .selectFrom('revisions')
            .select(['id', 'head_sha'])
            .where('id', 'in', priorRevisionIds)
            .execute();
          for (const r of revRows) priorHeadShas.set(r.id, r.head_sha);
        }
        priorBlockingFindings = priorBlocking.map((f) => {
          const lastSeenHeadSha = priorHeadShas.get(f.revisionId);
          return {
            findingId: f.id,
            fingerprint: f.fingerprint,
            claim: f.claim,
            ...(f.anchorText !== undefined ? { anchorText: f.anchorText } : {}),
            ...(f.path !== undefined ? { path: f.path } : {}),
            ...(lastSeenHeadSha !== undefined ? { lastSeenHeadSha } : {}),
          };
        });
      }
    }

    // Model tier selects the model only, not budgets or thresholds. Plan selector > env `LLM_MODEL_TIER` > LLM_MODEL.
    const selector =
      (await deps.resolveModelSelector?.(ctx)) ?? coerceModelTier(process.env.LLM_MODEL_TIER);
    // Tenant BYOK key wins (endpoints are hardcoded in BYOK_PROVIDERS; the key never reaches logs).
    // A concrete model identity from the plan is not passed to BYOK: BYOK is not limited by plan models.
    let model = await resolveByokModelSource(
      ctx,
      typeof selector === 'string' ? selector : undefined,
    );
    ctx.modelSourceKind = model ? 'byok' : 'platform';
    model ??= await deps.modelSource(selector);
    // Fallback models only for the platform source: BYOK pays for its own model choice.
    // Unresolvable candidates are skipped rather than failing the run.
    const fallbackModels: Model<string>[] = [];
    const fallbackModelConfigs: ModelSourceConfig[] = [];
    if (ctx.modelSourceKind === 'platform') {
      for (const sel of (await deps.resolveFallbackModelSelectors?.(ctx)) ?? []) {
        try {
          const src = await deps.modelSource(sel);
          fallbackModels.push(src.model);
          // Without config the model cannot run in the sandbox, only in-process.
          if (src.config) fallbackModelConfigs.push(src.config);
        } catch {
          /* unavailable (retired or endpoint not allowlisted): skip */
        }
      }
    }
    // Stage models: endpoints and keys still come only from env via modelSource. Unresolvable models are
    // skipped; if none resolve, the stage uses the default model.
    const stageSpecs = await deps.resolveStageModels?.(ctx);
    const stageResolvers = new Map<
      string,
      { strategy: string; picks: { model: Model<string>; fallbackModels?: Model<string>[] }[] }
    >();
    const stageModelConfigs: { stage: string; strategy: string; models: ModelSourceConfig[] }[] =
      [];
    for (const spec of stageSpecs ?? []) {
      const picks: { model: Model<string>; fallbackModels?: Model<string>[] }[] = [];
      const configs: ModelSourceConfig[] = [];
      for (const m of spec.models) {
        try {
          const src = await deps.modelSource({
            provider: m.provider,
            modelId: m.modelId,
            ...(m.metadata ? { metadata: m.metadata } : {}),
          });
          picks.push({ model: src.model });
          // The sandbox has no env, so endpoint and key travel in the spec.
          if (src.config) configs.push(src.config);
        } catch {
          /* unavailable (retired or endpoint not allowlisted): skip */
        }
      }
      if (configs.length > 0)
        stageModelConfigs.push({ stage: spec.stage, strategy: spec.strategy, models: configs });
      // Fallbacks are the stage's other models.
      const withFallbacks = picks.map((p, i) => {
        const rest = picks.filter((_, j) => j !== i).map((x) => x.model);
        return { model: p.model, ...(rest.length > 0 ? { fallbackModels: rest } : {}) };
      });
      if (withFallbacks.length > 0)
        stageResolvers.set(spec.stage, { strategy: spec.strategy, picks: withFallbacks });
    }
    const stageModel: OrchestratorStageModelResolver | undefined =
      stageResolvers.size > 0
        ? (stage, unitIndex) => {
            const r = stageResolvers.get(stage);
            if (!r) return undefined;
            return r.picks[
              pickStageModelIndex(
                r.picks.length,
                isStageStrategy(r.strategy) ? r.strategy : 'fill-first',
                unitIndex,
                ctx.payload.revisionId,
              )
            ];
          }
        : undefined;

    // `0` means unlimited, so only `undefined` falls back to env (not `||`).
    const planReviewCap = await deps.resolveReviewCostCapUsd?.(ctx);
    const envReviewCap = Number(process.env.REVIEW_COST_CAP_USD);
    const reviewCostCapUsd = planReviewCap ?? (Number.isFinite(envReviewCap) ? envReviewCap : 0);

    // Off by default: with session reuse, verify rejects more real bugs.
    const sessionReuse = settingOf('review.session_reuse') === '1';
    // fork-map only pays off if the gateway caches the shared prefix (check cacheRead in logs).
    const digForkFromMap = settingOf('review.dig_context') === 'fork-map';
    // Max concurrent `investigate` subagents in dig; `off`/1 disables the tool. The platform sets the ceiling, not the model.
    const subagentFanout = ((): number => {
      const v = settingOf('review.subagents');
      const n = Number(v);
      return v === 'off' || !Number.isFinite(n) ? 0 : n;
    })();

    // The dependency gate needs the unfiltered view: lockfiles are often excluded by path filters.
    const prefilterView = wsView;
    const pathFilter = await applyPathFilter(
      wsView,
      cfg.config.reviews.ignored_paths,
      async (paths) => {
        // Classified by the workspace (trusted `.gitattributes`, file headers, gitlinks) when it opened.
        // A submodule pointer has no content to review, so it is split out even without `skip_generated`.
        const asked = new Set(paths);
        return new Map(
          Object.entries(info.nonReviewable).filter(
            ([path, reason]) => asked.has(path) && (cfg.config.reviews.skip_generated || reason === 'submodule'),
          ),
        );
      },
    );
    wsView = pathFilter.wsView;
    const changedFiles = pathFilter.changedFiles;
    const ignoredFiles = pathFilter.ignoredFiles;
    const lfsPointers = ignoredFiles.flatMap((f) => ('reason' in f && f.reason === 'lfs-pointer' ? [f.path] : []));
    const lfsPointerPaths = lfsPointers.length > 0 ? lfsPointers : undefined;
    const submoduleBumps = submoduleBumpsOf(ignoredFiles, info.submodules);
    const changedPathSet = new Set(changedFiles.map((file) => file.path));
    const filteredFileStates = wsView.fileStates.filter((file) => changedPathSet.has(file.path));
    // Dependency findings skip LLM verify (the verifier cannot check advisories from code). Scan failures don't block.
    let dependencyFindings: DependencyFindingInput[] | undefined;
    if (deps.scanDependencies) {
      try {
        // Scan the unfiltered change set: ignored_paths means "don't review", not "don't scan".
        const allChangedPaths = [
          ...changedFiles.map((f) => f.path),
          ...ignoredFiles.map((i) => i.path),
        ];
        const scan = await deps.scanDependencies({
          workspace: plane,
          changedFiles: allChangedPaths,
          language: cfg.config.language,
        });
        if (scan && scan.vulnerabilities.length > 0) {
          dependencyFindings = await buildDependencyFindings(scan, {
            changedPaths: new Set(allChangedPaths),
            gate: cfg.config.reviews.dependency_gate,
            readHeadLines: prefilterView.readHeadLines,
            isChangedLine: prefilterView.isChangedLine,
          });
        }
      } catch {
        // Missing scanner, timeout or parse failure: no findings, review continues.
      }
    }

    // Risk factor scales the profile's exploration budget; verification standards are unaffected.
    const risk = classifyChangeRisk(changedFiles);
    const riskFactor = computeRiskFactor(risk);
    const budgetOverride = (v: string | undefined): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
    };
    const adaptiveTurns = Math.max(1, Math.round(cfg.budget.maxTurns * riskFactor));
    const stageBudgets = {
      map: stageBudgetMs(settingOf('review.stage_budget.map')),
      dig: stageBudgetMs(settingOf('review.stage_budget.dig')),
      synthesis: stageBudgetMs(settingOf('review.stage_budget.synthesis')),
    };

    // Default 200: running out of turns before the finishing tool wastes the whole run, while converging
    // models finish early anyway. `auto` = adaptive (profile x risk).
    const turnsSetting = settingOf('review.max_turns');
    const maxTurns =
      turnsSetting === 'auto'
        ? adaptiveTurns
        : (budgetOverride(turnsSetting) ?? 200);
    // `auto` = profile x risk, like the turn budget.
    const budget = {
      maxTurns,
      maxToolCalls:
        budgetOverride(settingOf('review.max_tool_calls')) ??
        Math.max(1, Math.round(cfg.budget.maxToolCalls * riskFactor)),
    };

    // Images are described only when a `vlm` stage model is configured: the main model may lack vision,
    // and sending customer images is an explicit operator decision.
    let imageContext: string | undefined;
    const vlmPick = stageResolvers.get('vlm')?.picks[0];
    if (vlmPick && deps.fetchChangeRequestImages) {
      const images = await deps.fetchChangeRequestImages(ctx).catch(() => []);
      const described = await describePrImages(
        {
          model: vlmPick.model,
          ...(vlmPick.fallbackModels ? { fallbackModels: vlmPick.fallbackModels } : {}),
          streamFn: model.streamFn,
          budget,
        },
        images,
      );
      imageContext = described?.text;
    }

    const dedupStrategy = resolveDedupStrategy(
      model,
      budget,
      process.env,
      settingOf('review.dedup'),
    );
    const executorDedupSpec = resolveExecutorDedupSpec(process.env, settingOf('review.dedup'));

    // Reuses the review model: one text-only call per round. The tiny budget suffices for one submit_links call.
    const matcherBase = resolveFindingMatcher(
      model,
      process.env,
      settingOf('review.finding_match'),
    );
    const findingMatcher = matcherBase
      ? createLlmFindingMatcher({ ...matcherBase, budget: { maxTurns: 2, maxToolCalls: 2 } })
      : undefined;

    if (ctx.payload.tenantId && ctx.payload.repositoryId) {
      const triggers = detectCrossRepoTriggers(changedFiles.map((f) => f.path));
      if (triggers.length > 0) {
        const relationships = await loadEnabledRelationships(ctx.db, ctx.payload.repositoryId);
        // Same-tenant relationships are authorized by default; target repos are always read-only.
        const authorized = relationships.filter(
          (r) =>
            evaluateCrossRepoAccess({ relationship: r, sameTenant: true, explicitlyShared: false })
              .allowed,
        );
        // Must not be nested under `authorized.length > 0`: cross-tenant links are independent of same-tenant ones.
        // Writes cross_tenant_events with source_tenant_id = this tenant, so it stays inside this tenant's RLS
        // context; the downstream tenant's intake job picks the events up.
        if (ctx.payload.tenantId) {
          const crossTenant = await loadActiveCrossTenantForSource(
            ctx.db,
            ctx.payload.repositoryId,
          );
          for (const rel of crossTenant) {
            try {
              await recordCrossTenantEvent(ctx.db, {
                relationshipId: rel.id,
                sourceTenantId: ctx.payload.tenantId,
                sourceRepositoryId: ctx.payload.repositoryId,
                targetTenantId: rel.targetTenantId,
                targetRepositoryId: rel.targetRepositoryId,
                kind: 'contract-change',
                sourceRevisionId: ctx.payload.revisionId,
                payload: { contractPaths: [...new Set(triggers.flatMap((t) => t.files))] },
              });
            } catch (error) {
              // Don't block the review, but never fail silently: record the error.
              await ctx.db
                .insertInto('audit_events')
                .values({
                  id: uuidv7(),
                  tenant_id: ctx.payload.tenantId,
                  actor: 'review',
                  action: 'cross-tenant.event-failed',
                  target: rel.id,
                  detail: {
                    targetTenantId: rel.targetTenantId,
                    error: (error as Error)?.message ?? String(error),
                  } as unknown as Record<string, unknown>,
                  created_at: new Date(),
                })
                .execute()
                .catch(() => undefined);
            }
          }
        }
        if (authorized.length > 0) {
          await ctx.db
            .insertInto('audit_events')
            .values({
              id: uuidv7(),
              tenant_id: ctx.payload.tenantId,
              actor: 'review',
              action: 'cross-repo.impact',
              target: ctx.payload.repositoryId,
              detail: {
                triggers: triggers.map((t) => ({ kind: t.kind, files: t.files })),
                consumers: authorized.map((r) => ({
                  repositoryId: r.targetRepositoryId,
                  kind: r.kind,
                })),
                revisionId: ctx.payload.revisionId,
              } as unknown as Record<string, unknown>,
              created_at: new Date(),
            })
            .execute();
          if (deps.onCrossRepoImpact && cfg.config.cross_repo.analyze.enabled) {
            const contractContext: CrossRepoImpact['contractContext'] = [];
            let totalBytes = 0;
            const contractPaths = [...new Set(triggers.flatMap((t) => t.files))];
            for (const path of contractPaths) {
              if (totalBytes >= 100_000) break;
              const content = await wsView.source.readFile(path);
              if (content === null) continue; // deleted; still listed in triggers
              const slice = content.slice(0, 30_000);
              totalBytes += slice.length;
              contractContext.push({
                path,
                headContent: slice,
                truncated: slice.length < content.length,
              });
            }
            await deps
              .onCrossRepoImpact({
                tenantId: ctx.payload.tenantId,
                sourceRepositoryId: ctx.payload.repositoryId,
                revisionId: ctx.payload.revisionId,
                triggers: triggers.map((t) => ({ kind: t.kind, files: t.files })),
                consumers: authorized.map((r) => ({
                  repositoryId: r.targetRepositoryId,
                  relationshipId: r.id,
                  kind: r.kind,
                  ...(r.instructions ? { instructions: r.instructions } : {}),
                })),
                contractContext,
              })
              .catch(() => undefined);
          }
        }
      }
    }

    const contextLines: string[] = [];
    // Long rules / fact details listed in short form; full text via knowledge_read (prefetched).
    const knowledgeEntries: KnowledgeToolEntry[] = [];

    const raw: RawAuthoritativeRule[] = cfg.config.instructions.paths.map((p) => ({
      instruction: p.instructions,
      source: 'reviewbot-yaml' as const,
      selector: p.path,
    }));
    const rules = collectAuthoritativeRules(raw);
    for (const r of rules)
      contextLines.push(`- [${r.source}${r.selector ? ` ${r.selector}` : ''}] ${r.instruction}`);
    // Repository guidance is background data, kept out of the mandatory rules section.
    const guidance = cfg.config.knowledge.repository_docs
      ? await loadRepositoryGuidance(
          readTrustedFile,
          changedFiles.map((f) => f.path),
        )
      : { files: [], rejected: [] };
    const repositoryGuidance = renderRepositoryGuidance(guidance.files);
    // The review standard (part of the contract) uses all applicable knowledge, not the LLM-selected subset.
    const standardLines = [...contextLines, ...(repositoryGuidance ? [repositoryGuidance] : [])];

    if (ctx.payload.tenantId && ctx.payload.repositoryId) {
      // Participants as `provider:numericId`, matched against user-scoped knowledge subject_ref.
      const participants: string[] = [];
      const authorRow = await ctx.db
        .selectFrom('revisions')
        .innerJoin('change_requests', 'change_requests.id', 'revisions.change_request_id')
        .innerJoin('repositories', 'repositories.id', 'change_requests.repository_id')
        .innerJoin('provider_hosts', 'provider_hosts.id', 'repositories.provider_host_id')
        .select([
          'change_requests.author as author',
          'change_requests.author_provider_id as authorProviderId',
          'change_requests.reviewers as reviewers',
          'provider_hosts.provider as provider',
        ])
        .where('revisions.id', '=', ctx.payload.revisionId)
        .executeTakeFirst();
      if (authorRow?.authorProviderId)
        participants.push(`${authorRow.provider}:${authorRow.authorProviderId}`);
      for (const r of authorRow?.reviewers ?? []) {
        if (r.providerUserId) participants.push(`${authorRow!.provider}:${r.providerUserId}`);
      }
      const loaded = await loadApplicableKnowledge(ctx.db, {
        tenantId: ctx.payload.tenantId,
        repositoryId: ctx.payload.repositoryId,
        participants,
      });
      for (const i of loaded) standardLines.push(`${i.id}\t${i.content}`);
      const changedPaths = changedFiles.map((f) => f.path);
      // Few items are injected in full; many go through LLM selection. `knowledge.select` = 0 uses path ordering.
      let selectedItems: RetrievalItem[];
      let usedIds: string[] = [];
      if (settingOf('knowledge.select') !== '0' && loaded.length > 0) {
        const injectAllThreshold = positiveIntSetting('knowledge.inject_all_threshold');
        const selectCap = positiveIntSetting('knowledge.select_cap');
        const sel = await selectKnowledge(loaded, {
          model: model.model,
          streamFn: model.streamFn,
          budget,
          changedPaths,
          ...(deps.changeSummary !== undefined ? { changeSummary: deps.changeSummary } : {}),
          ...(injectAllThreshold !== undefined ? { injectAllThreshold } : {}),
          ...(selectCap !== undefined ? { selectCap } : {}),
        });
        selectedItems = sel.items;
        usedIds = sel.usedIds;
      } else {
        selectedItems = orderKnowledgeForPaths(loaded, changedPaths);
      }
      for (const i of selectedItems) contextLines.push(ruleLine(i, knowledgeEntries));
      if (usedIds.length > 0) await markLearningsUsed(ctx.db, usedIds).catch(() => undefined);
    }
    const knowledgeContext = contextLines.length > 0 ? contextLines.join('\n') : undefined;

    // Memories are prefetched here (no DB in the sandbox) and kept out of the review contract,
    // since they update after every review.
    let memoryContext: string | undefined;
    let memoryTools: AgentTool[] | undefined;
    // Raw entries let the sandbox executor rebuild memoryTools (closures cannot be serialized).
    let memoryEntriesRaw:
      | {
          id: string;
          kind: string;
          title: string;
          summary: string;
          body: string;
          links: string[];
        }[]
      | undefined;
    if (ctx.payload.tenantId && ctx.payload.repositoryId) {
      const memories = await listAgentMemories(
        ctx.db,
        ctx.payload.tenantId,
        ctx.payload.repositoryId,
      );
      const idx = buildMemoryIndex(
        memories,
        changedFiles.map((f) => f.path),
      );
      if (idx.indexText !== undefined) {
        memoryContext = idx.indexText;
        memoryEntriesRaw = idx.entries.map((m) => ({
          id: m.id,
          kind: m.kind,
          title: m.title,
          summary: m.summary,
          body: m.body,
          links: m.links,
        }));
        memoryTools = buildMemoryTools(memoryEntriesRaw);
      }
    }
    // Ecosystem facts stay out of the review contract: approving a fact must not invalidate reviewed files.
    const factsSelection = await ecosystemFactsFor(ctx.db, async () => {
      const files = await plane.client.readFiles(info.manifestPaths);
      return info.manifestPaths.flatMap((path) => (files[path] != null ? [{ path, text: files[path]! }] : []));
    });
    const ecosystemFacts = factsSelection?.text;
    if (factsSelection) knowledgeEntries.push(...factsSelection.longEntries);
    const knowledgeTools = buildKnowledgeTools(knowledgeEntries);
    // Skill bodies are part of the review standard, so editing a skill invalidates prior coverage.
    const skills = mergeSkills(
      deps.skills ?? [],
      info.skills,
    );
    for (const skill of skills) standardLines.push(skillStandardLine(skill));
    const reviewContractDigest = buildReviewContractDigest({
      configDigest: cfg.configDigest,
      promptDigests: Object.values(deps.bundles).map((bundle) => ({
        role: bundle.role,
        digest: bundle.digest,
      })),
      // Changing the model or tier invalidates prior coverage.
      modelIdentity: {
        id: model.config ? `${model.config.provider}:${model.config.modelId}` : 'unresolved',
        ...(typeof selector === 'string' ? { tier: selector } : {}),
      },
      // Stage models count too: changing only the dig model must invalidate coverage.
      ...(stageModelConfigs.length > 0
        ? {
            stageModels: stageModelConfigs.map((stage) => ({
              stage: stage.stage,
              models: stage.models.map((m) => `${m.provider}:${m.modelId}`),
            })),
          }
        : {}),
      ...(standardLines.length > 0 ? { reviewStandard: [...standardLines].sort().join('\n') } : {}),
    });
    const partition =
      !ctx.payload.forceFullReview && coverageCrId && ctx.payload.tenantId
        ? await partitionReviewFiles({
            db: ctx.db,
            tenantId: ctx.payload.tenantId,
            changeRequestId: coverageCrId,
            files: filteredFileStates,
            reviewContractDigest,
          }).catch(() => undefined)
        : undefined;
    const statePaths = new Set(filteredFileStates.map((file) => file.path));
    /*
     * Unchanged reviewed files are re-reviewed when a file their last review read changed since covered_at_sha.
     * When this cannot be determined, re-review.
     */
    const dependencyStale = partition
      ? await filesWithStaleDependencies(partition, (sha) =>
          plane.client.changedFilesBetween(sha).then((files) => (files ? new Set(files) : null)),
        )
      : new Set<string>();
    // An empty delta must fall back to a full review: zero scopes would otherwise approve without reading any code.
    const reusablePaths = partition
      ? new Set([...partition.deltaFiles.map((file) => file.path), ...dependencyStale])
      : undefined;
    const deltaPaths = new Set(
      reusablePaths
        ? [
            ...reusablePaths,
            ...changedFiles.filter((file) => !statePaths.has(file.path)).map((file) => file.path),
          ]
        : changedFiles.map((file) => file.path),
    );
    if (deltaPaths.size === 0) for (const file of changedFiles) deltaPaths.add(file.path);
    const deltaChangedFiles = changedFiles.filter((file) => deltaPaths.has(file.path));
    // Files beyond `files_per_round` are deferred to the next round; deferred files still count as uncovered.
    const { round: roundChangedFiles, deferred: deferredPaths } = pickReviewRound(
      deltaChangedFiles,
      cfg.config.reviews.files_per_round,
    );
    const priorReviewedPaths = changedFiles
      .filter((file) => !deltaPaths.has(file.path))
      .map((file) => file.path);
    /*
     * Findings on files not reviewed this round are carried into the summary, but only if the round that last
     * covered the file still reported them and they were published (inline/summary).
     */
    const coveredAtSha = partition?.coveredAtSha;
    const carriedFindings: CarriedFinding[] = activePrior.flatMap((f) =>
      f.path &&
      f.lastSeenHeadSha !== undefined &&
      coveredAtSha?.get(f.path) === f.lastSeenHeadSha &&
      (f.state === 'inline' || f.state === 'summary') &&
      f.severity
        ? [
            {
              findingId: f.id,
              fingerprint: f.fingerprint,
              category: f.category,
              claim: f.claim,
              severity: f.severity,
              path: f.path,
              ...(f.lastLine !== undefined ? { line: f.lastLine } : {}),
              ...(f.effort ? { effort: f.effort } : {}),
            },
          ]
        : [],
    );
    // Published non-blocking findings on files re-reviewed this round (deferred files excluded), reconciled
    // when not reported again. Blocking ones go through gate reconciliation instead.
    const deltaPathSet = new Set(roundChangedFiles.map((file) => file.path));
    const priorBlockingIds = new Set((priorBlockingFindings ?? []).map((p) => p.findingId));
    const openPriorFindings: OpenPriorFinding[] = activePrior.flatMap((f) =>
      f.path &&
      deltaPathSet.has(f.path) &&
      !priorBlockingIds.has(f.id) &&
      (f.state === 'inline' || f.state === 'summary') &&
      f.severity
        ? [
            {
              findingId: f.id,
              fingerprint: f.fingerprint,
              category: f.category,
              claim: f.claim,
              severity: f.severity,
              path: f.path,
              ...(f.lastLine !== undefined ? { line: f.lastLine } : {}),
              ...(f.effort ? { effort: f.effort } : {}),
              ...(f.lastSeenHeadSha !== undefined ? { lastSeenHeadSha: f.lastSeenHeadSha } : {}),
              ...(f.anchorText !== undefined ? { anchorText: f.anchorText } : {}),
            },
          ]
        : [],
    );
    // Previous note plus diff since covered_at_sha, batched per covered_at_sha.
    const roundDiffs = new Map<string, string>();
    const bySince = new Map<string, string[]>();
    for (const file of changedFiles) {
      const prev = partition?.previous.get(file.path);
      if (prev && deltaPaths.has(file.path)) bySince.set(prev.coveredAtSha, [...(bySince.get(prev.coveredAtSha) ?? []), file.path]);
    }
    for (const [sinceSha, paths] of bySince) {
      const diffs = await plane.client.diffSince(sinceSha, paths, ROUND_DIFF_MAX_CHARS);
      for (const [path, diff] of Object.entries(diffs)) roundDiffs.set(path, diff);
    }
    const fileContext: NonNullable<ReviewOrchestratorDeps['fileContext']>[number][] = [];
    for (const file of changedFiles) {
      const prev = partition?.previous.get(file.path);
      if (!prev) continue;
      const roundDiff = roundDiffs.get(file.path);
      if (prev.note || roundDiff)
        fileContext.push({
          path: file.path,
          ...(prev.note ? { note: prev.note } : {}),
          ...(roundDiff ? { roundDiff } : {}),
        });
    }
    const filePatches = await plane.client.readPatches(
      roundChangedFiles.map((f) => f.path),
      PATCH_MAX_CHARS_PER_FILE,
      PATCH_MAX_TOTAL_CHARS,
    );
    // Small changes skip the LLM map; `review.fast_map` = 0 disables this.
    const deltaChangedLineCount = roundChangedFiles.reduce((n, f) => n + (info.headChangedLines[f.path]?.length ?? 0), 0);
    const plannedScopes =
      settingOf('review.fast_map') !== '0' &&
      roundChangedFiles.length > 0 &&
      roundChangedFiles.length <= FAST_MAP_MAX_FILES &&
      deltaChangedLineCount <= FAST_MAP_MAX_LINES
        ? [plannedScopeFor(roundChangedFiles.map((f) => f.path))]
        : undefined;
    // Restrict discovery enumeration only. Arbitrary source reads and searches still use
    // the complete workspace so delta analysis can follow cross-file dependencies.
    wsView = {
      ...wsView,
      source: {
        listChangedFiles: async () => roundChangedFiles,
        readFile: (path) => pathFilter.wsView.source.readFile(path),
        searchCode: (query) => pathFilter.wsView.source.searchCode(query),
        ...(pathFilter.wsView.source.searchSymbol
          ? { searchSymbol: (symbol: string) => pathFilter.wsView.source.searchSymbol!(symbol) }
          : {}),
      },
    };

    const collectMemories = cfg.config.knowledge.memory.enabled;

    // Plugin credentials: user > repo > org (KMS-decrypted) > platform env. Without a KMS key only env applies.
    let tenantCredentials: Awaited<ReturnType<typeof resolveServiceCredentials>> | undefined;
    if (ctx.payload.tenantId && ctx.payload.repositoryId) {
      const kek = masterKeyFromEnv();
      if (kek) {
        tenantCredentials = await resolveServiceCredentials(ctx.db, kek, {
          tenantId: ctx.payload.tenantId,
          repositoryId: ctx.payload.repositoryId,
          ...(ctx.payload.initiatedByUserId ? { userId: ctx.payload.initiatedByUserId } : {}),
        });
      }
    }
    // The review cost writer sums costUsd from these audit events by revisionId.
    const auditTenantId = ctx.payload.tenantId;
    const auditRepositoryId = ctx.payload.repositoryId;
    const onPluginCall =
      auditTenantId && auditRepositoryId
        ? async (event: PluginToolCallEvent): Promise<void> => {
            recordPluginCall(event.plugin, event.tool, event.keySource);
            await ctx.db
              .insertInto('audit_events')
              .values({
                id: uuidv7(),
                tenant_id: auditTenantId,
                actor: 'review',
                action: 'plugin.call',
                target: auditRepositoryId,
                detail: {
                  plugin: event.plugin,
                  tool: event.tool,
                  revisionId: ctx.payload.revisionId,
                  keySource: event.keySource,
                  costUsd: pluginCallCostUsd(event.plugin, event.tool, event.keySource),
                  ...(event.args ? { args: event.args } : {}),
                } as unknown as Record<string, unknown>,
                created_at: new Date(),
              })
              .execute();
          }
        : undefined;
    const plugins = resolvePluginTools({
      plugins: cfg.config.plugins,
      ...(tenantCredentials ? { credentials: tenantCredentials } : {}),
      ...(onPluginCall ? { onToolCall: onPluginCall } : {}),
    });

    // Langfuse export needs all three settings, otherwise it is off. buildEnv runs inside withLlmTraceContext.
    const telemetrySpec = ((): ReviewExecutorSpec['telemetry'] => {
      const endpoint = process.env.LANGFUSE_OTLP_ENDPOINT;
      const pk = process.env.LANGFUSE_PUBLIC_KEY;
      const sk = process.env.LANGFUSE_SECRET_KEY;
      const trace = currentLlmTraceContext();
      // Sandbox spans return via the output file and are forwarded by the control plane, so always pass the carrier.
      const traceCarrier = currentTraceCarrier();
      return {
        ...(endpoint && pk && sk ? { langfuseEndpoint: endpoint, langfusePublicKey: pk, langfuseSecretKey: sk } : {}),
        ...(trace ? { trace } : {}),
        ...(traceCarrier ? { traceCarrier } : {}),
      };
    })();

    // null when sinceSha is not in the clone; callers must then verify with the LLM rather than guess.
    const filesChangedSince = async (sinceSha: string): Promise<ReadonlySet<string> | null> =>
      plane.client.changedFilesBetween(sinceSha).then((files) => (files ? new Set(files) : null));
    // Changed files not yet explored by any round; deletions and pure renames have nothing to explore.
    const uncoveredPaths = coverageCrId
      ? deltaChangedFiles.filter(hasReviewableContent).map((file) => file.path)
      : undefined;

    // Lets the sandbox executor rebuild closures; relayExecutorSpec swaps keys for relay tokens before it
    // leaves this host. Omitted without model config, which forces in-process execution.
    const executorSpec: ReviewExecutorSpec | undefined =
      model.config
        ? {
            revisionSha: wsView.headSha,
            revisionId: ctx.payload.revisionId,
            changedFiles: roundChangedFiles,
            headChangedLines: Object.fromEntries(
              Object.entries(info.headChangedLines).filter(([path]) => changedPathSet.has(path)),
            ),
            model: model.config,
            ...(fallbackModelConfigs.length > 0 ? { fallbackModels: fallbackModelConfigs } : {}),
            budget,
            ...(plugins.tools.length > 0
              ? {
                  plugins: {
                    config: cfg.config.plugins,
                    ...(tenantCredentials ? { credentials: tenantCredentials } : {}),
                    platformEnv: platformPluginEnv(),
                  },
                }
              : {}),
            ...(memoryEntriesRaw ? { memoryEntries: memoryEntriesRaw } : {}),
            ...(knowledgeEntries.length > 0 ? { knowledgeEntries } : {}),
            ...(deps.changeSummary !== undefined ? { changeSummary: deps.changeSummary } : {}),
            ...(knowledgeContext !== undefined ? { knowledgeContext } : {}),
            ...(repositoryGuidance !== undefined ? { repositoryGuidance } : {}),
            ...(lfsPointerPaths !== undefined ? { lfsPointerPaths } : {}),
            ...(submoduleBumps !== undefined ? { submoduleBumps } : {}),
            ...(memoryContext !== undefined ? { memoryContext } : {}),
            ...(ecosystemFacts !== undefined ? { ecosystemFacts } : {}),
            ...(imageContext !== undefined ? { imageContext } : {}),
            ...(collectMemories ? { collectMemories } : {}),
            exploration: {
              analyzeRelatedCode: cfg.config.reviews.scope.analyze_related_code,
              analyzePreexistingRelevant: cfg.config.reviews.scope.analyze_preexisting_relevant,
              maxDependencyDepth: cfg.config.reviews.scope.max_dependency_depth,
            },
            language: cfg.config.language,
            digConcurrency,
            verifyConcurrency,
            stageBudgetMs: stageBudgets,
            verifyBudgetMs: stageBudgetMs(settingOf('review.stage_budget.verify')),
            // The sandbox has no DB, so everything the engine needs travels in the spec.
            ...(uncoveredPaths !== undefined ? { uncoveredPaths } : {}),
            ...(priorReviewedPaths.length > 0 ? { priorReviewedPaths } : {}),
            ...(plannedScopes ? { plannedScopes } : {}),
            ...(fileContext.length > 0 ? { fileContext } : {}),
            filePatches,
            ...(skills.length > 0 ? { skills } : {}),
            reviewFileStates: filteredFileStates.map(({ path, materialDigest }) => ({
              path,
              materialDigest,
            })),
            reviewContractDigest,
            promptDigests: Object.values(deps.bundles).map((bundle) => ({
              role: bundle.role,
              digest: bundle.digest,
            })),
            ...(reviewCostCapUsd > 0 ? { costCapUsd: reviewCostCapUsd } : {}),
            ...(executorDedupSpec ? { dedup: executorDedupSpec } : {}),
            ...(stageModelConfigs.length > 0 ? { stageModels: stageModelConfigs } : {}),
            verifyVotes,
            ...(sessionReuse ? { sessionReuse: true } : {}),
            ...(digForkFromMap ? { digForkFromMap: true } : {}),
            // Half the parent's budget, so fanning out does not multiply the run's turn budget.
            ...(subagentFanout > 1
              ? {
                  subagents: {
                    maxTasks: subagentFanout,
                    maxConcurrency: subagentFanout,
                    budget: {
                      maxTurns: Math.max(4, Math.floor(budget.maxTurns / 2)),
                      maxToolCalls: Math.max(4, Math.floor(budget.maxToolCalls / 2)),
                    },
                  },
                }
              : {}),
            ...(subagentFanout > 1 ? { subagentFanout } : {}),
            ...(telemetrySpec ? { telemetry: telemetrySpec } : {}),
          }
        : undefined;

    return {
      disposeWorkspace,
      codePlane: plane,
      runner: cfg.config.sandbox.runner,
      ...(executorSpec ? { executorSpec } : {}),
      ...(onPluginCall ? { onPluginCall } : {}),
      source: wsView.source,
      model: model.model,
      ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
      ...(stageModel ? { stageModel } : {}),
      streamFn: model.streamFn,
      bundles: deps.bundles,
      budget,
      readHeadLines: wsView.readHeadLines,
      isChangedLine: wsView.isChangedLine,
      publishContext: {
        db: ctx.db,
        discussions,
        fetchCurrentHeadSha: deps.fetchCurrentHeadSha
          ? () => deps.fetchCurrentHeadSha!(ctx)
          : async () => wsView.headSha,
      },
      noiseBudget: cfg.noiseBudget,
      profile: cfg.profile,
      digConcurrency,
      verifyConcurrency,
      // On deadline a stage moves on instead of failing the run.
      stageBudgetMs: stageBudgets,
      verifyBudgetMs: stageBudgetMs(settingOf('review.stage_budget.verify')),
      ...(reviewCostCapUsd > 0 ? { costCapUsd: reviewCostCapUsd } : {}),
      verifyVotes,
      ...(sessionReuse ? { sessionReuse: true } : {}),
      ...(dedupStrategy ? { dedupStrategy } : {}),
      language: cfg.config.language,
      autoApprove: cfg.config.reviews.auto_approve,
      // merge_gate.enabled only controls the Check Run, not which severities block.
      blockOnSeverity: cfg.config.merge_gate.block_on_severity,
      blockPreexisting: cfg.config.reviews.block_preexisting,
      suggestionsEnabled: cfg.config.reviews.publication.committable_suggestions,
      suggestionMaxLines: cfg.config.reviews.publication.committable_suggestion_max_lines,
      summaryOverflow: cfg.config.reviews.publication.summary_overflow,
      showUnverifiedRisks: cfg.config.reviews.publication.show_unverified_risks,
      showSuppressedDetails: cfg.config.reviews.publication.show_suppressed_details,
      minConfirmation: cfg.config.reviews.publication.min_confirmation,
      ...(deps.botMention !== undefined ? { botMention: deps.botMention } : {}),
      ...(updateSummaryDescription ? { updateSummaryDescription } : {}),
      ...(priorFingerprints ? { priorFingerprints } : {}),
      // Without both, the orchestrator falls back to fingerprint matching.
      ...(findingMatcher && priorFindings && priorFindings.length > 0
        ? { findingMatcher, priorFindings }
        : {}),
      ...(carriedFindings.length > 0 ? { carriedFindings } : {}),
      ...(openPriorFindings.length > 0 ? { openPriorFindings } : {}),
      ...(dismissedFindings && dismissedFindings.length > 0 ? { dismissedFindings } : {}),
      ...(stack ? { stack } : {}),
      ...(computeFingerprint ? { computeFingerprint } : {}),
      ...(computeWeakFingerprint ? { computeWeakFingerprint } : {}),
      ...(priorBlockingFindings && priorBlockingFindings.length > 0
        ? { priorBlockingFindings }
        : {}),
      ...(staleCandidates && staleCandidates.length > 0 ? { staleCandidates } : {}),
      filesChangedSince,
      // Drives scope ordering (uncovered first) and PR-level coverage for approve/gate, not per-round scope counts.
      ...(uncoveredPaths ? { uncoveredPaths } : {}),
      ...(deferredPaths.length > 0 ? { deferredPaths } : {}),
      selectedPaths: roundChangedFiles.filter((f) => f.status !== 'deleted').map((f) => f.path),
      runConfig: {
        source: cfg.hasRepoFile ? ('repository' as const) : panelLayer ? ('panel' as const) : ('default' as const),
        profile: cfg.config.reviews.profile,
      },
      ...(commitBase ? { commitRange: { base: commitBase, head: wsView.headSha } } : {}),
      ...(priorReviewedPaths.length > 0 ? { priorReviewedPaths } : {}),
      ...(plannedScopes ? { plannedScopes } : {}),
      ...(fileContext.length > 0 ? { fileContext } : {}),
      filePatches,
      ...(skills.length > 0 ? { skills } : {}),
      reviewFileStates: filteredFileStates.map(({ path, materialDigest }) => ({
        path,
        materialDigest,
      })),
      reviewContractDigest,
      ...(digForkFromMap ? { digForkFromMap: true } : {}),
      reportPreexistingUnrelated: cfg.config.reviews.scope.report_preexisting_unrelated,
      ...(ignoredFiles.length > 0 ? { ignoredFiles } : {}),
      exploration: {
        analyzeRelatedCode: cfg.config.reviews.scope.analyze_related_code,
        analyzePreexistingRelevant: cfg.config.reviews.scope.analyze_preexisting_relevant,
        maxDependencyDepth: cfg.config.reviews.scope.max_dependency_depth,
      },
      ...(deps.changeSummary !== undefined ? { changeSummary: deps.changeSummary } : {}),
      ...(knowledgeContext !== undefined ? { knowledgeContext } : {}),
      ...(repositoryGuidance !== undefined ? { repositoryGuidance } : {}),
      ...(lfsPointerPaths !== undefined ? { lfsPointerPaths } : {}),
      ...(submoduleBumps !== undefined ? { submoduleBumps } : {}),
      guidanceReport: { files: guidance.files.map((f) => f.path), rejected: guidance.rejected },
      // Merged directly by publishReview as tool-confirmed findings, never shown to map/dig.
      ...(dependencyFindings && dependencyFindings.length > 0 ? { dependencyFindings } : {}),
      ...(memoryContext !== undefined ? { memoryContext } : {}),
      ...(ecosystemFacts !== undefined ? { ecosystemFacts } : {}),
      ...(memoryTools !== undefined ? { memoryTools } : {}),
      ...(knowledgeTools.length > 0 ? { knowledgeTools } : {}),
      ...(collectMemories ? { collectMemories } : {}),
      ...(plugins.tools.length > 0 ? { pluginTools: plugins.tools, lookupSources: plugins.sources } : {}),
    };
  };

  return async (ctx: RuntimeCtx): Promise<ReviewEnv> => {
    let dispose: (() => Promise<void>) | undefined;
    try {
      return await build(ctx, (d) => {
        dispose = d;
      });
    } catch (err) {
      // The caller never gets an env to dispose, so release the workspace here.
      await dispose?.().catch(() => undefined);
      throw err;
    }
  };
}

/**
 * Resolves the tenant's BYOK model (user > repo > org), or null for the platform key.
 * BYOK base URLs are hardcoded in BYOK_PROVIDERS, so LLM_ALLOWED_BASE_URLS does not apply; LLM_ALLOWED_PROVIDERS does.
 * When a configured BYOK cannot be used, the reason is recorded so the console can tell the user.
 */
async function resolveByokModelSource(
  ctx: RuntimeCtx,
  tier: ModelTier | undefined,
): Promise<ModelSource | null> {
  if ((await platformSetting(ctx.db, 'byok.enabled')) === '0') return null;
  if (!ctx.payload.tenantId || !ctx.payload.repositoryId) return null;
  const kek = masterKeyFromEnv();
  if (!kek) return null;
  // A user's own key is used only for runs that user started.
  const byok = await resolveByok(ctx.db, kek, {
    tenantId: ctx.payload.tenantId,
    repositoryId: ctx.payload.repositoryId,
    ...(ctx.payload.initiatedByUserId ? { userId: ctx.payload.initiatedByUserId } : {}),
  });
  if (!byok) return null;
  const record = (fallback?: ByokFallbackReason): Promise<void> =>
    recordByokOutcome(ctx.db, byok.id, fallback).catch(() => undefined);
  if ('error' in byok) {
    await record(byok.error);
    return null;
  }
  const cfg = byok.config;
  try {
    assertModelEndpointAllowed({ provider: cfg.provider });
  } catch {
    await record('provider_disabled');
    return null;
  }
  const modelId =
    (tier === 'quality' ? cfg.modelQuality : tier === 'cheap' ? cfg.modelCheap : undefined) ?? cfg.model;
  const spec = await byokModelSpec(ctx.db, cfg.provider, modelId, cfg.templateModel).catch(() => undefined);
  if (!spec) {
    await record('model_unknown');
    return null;
  }
  let source: ModelSource;
  try {
    source = createModelSource({
      provider: cfg.provider,
      modelId,
      baseUrl: BYOK_PROVIDERS[cfg.provider].baseUrl,
      apiKey: cfg.apiKey,
      ...(cfg.templateModel ? { templateModelId: cfg.templateModel } : {}),
      ...(spec.metadata ? { metadata: spec.metadata } : {}),
    });
  } catch {
    await record('model_unknown');
    return null;
  }
  await record();
  return source;
}

const DEP_SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/**
 * A vulnerability is introduced when its manifest changed and, if the pinning line can be located, that line
 * changed; unlocatable (transitive) pins stay introduced. Blocking = introduced and severity at or above the gate.
 */
async function buildDependencyFindings(
  scan: DependencyScanOutcome,
  ctx: {
    changedPaths: Set<string>;
    gate: 'critical' | 'high' | 'off';
    readHeadLines: (p: string) => Promise<string[]>;
    isChangedLine: (p: string, line: number) => boolean;
  },
): Promise<DependencyFindingInput[]> {
  const threshold = ctx.gate === 'critical' ? 4 : 3;
  const headLineCache = new Map<string, string[] | null>();
  const out: DependencyFindingInput[] = [];
  for (const v of scan.vulnerabilities) {
    const manifest = v.manifestPath;
    let introduced = false;
    if (manifest && ctx.changedPaths.has(manifest)) {
      introduced = true;
      let lines = headLineCache.get(manifest);
      if (lines === undefined) {
        lines = await ctx.readHeadLines(manifest).catch(() => null);
        headLineCache.set(manifest, lines);
      }
      if (lines) {
        const idx = locatePinLine(lines, v.package, v.installedVersion);
        if (idx >= 0) introduced = ctx.isChangedLine(manifest, idx + 1);
      }
    }
    out.push({
      claim: v.claim,
      path: manifest ?? 'dependencies',
      severity: v.severity,
      advisoryId: v.advisoryId,
      introduced,
      blocking: ctx.gate !== 'off' && introduced && (DEP_SEV_RANK[v.severity] ?? 0) >= threshold,
    });
  }
  return out;
}
