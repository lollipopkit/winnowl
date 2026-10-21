import { resolveModelSourceFromEnv, type ModelTier, type ResolvedModelSource } from '@reviewbot/agent-pi';
import { platformSetting } from '@reviewbot/config';
import type { Db } from '@reviewbot/db';
import { activeModels, type RegisteredModel } from '@reviewbot/entitlement';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import { createPostMergeHandler } from '../post-merge.js';
import { createIssueEnrichHandler } from '../issue-enrich.js';
import { createGlobalLearningProposeHandler, type GlobalLearningModels } from '../global-learning-propose.js';
import { toModelIdentity, type PlatformModels } from '../platform-models.js';
import { createCrossRepoAnalyzeHandler } from '../cross-repo-analyze.js';
import { createLearningProposeHandler } from '../learning-propose.js';
import { createMemoryConsolidateHandler } from '../memory-consolidate.js';
import { createMemoryProposeHandler } from '../memory-propose.js';
import { createEcosystemFactProposeHandler } from '../ecosystem-fact-propose.js';
import { createPipelineAnalyzeHandler } from '../pipeline-analyze.js';
import { createPostMergeExecutor } from '../post-merge-executor.js';
import type { JobHandler } from '../supervisor.js';
import { repositoryRefFromRow } from '../repository-ref.js';
import { notWired, type RunnerRuntime } from './runtime.js';

type PanelMember = { id: string; source: ResolvedModelSource };

/** Global learning models, drafted by the default model; the panel follows `knowledge.global_panel`. */
export async function resolveGlobalLearningModels(
  db: Db,
  platformModels: PlatformModels,
  { env = process.env, loadRegistry = () => activeModels(db) }: {
    env?: NodeJS.ProcessEnv;
    loadRegistry?: () => Promise<RegisteredModel[]>;
  } = {},
): Promise<GlobalLearningModels | null> {
  const draft = platformModels.source();
  if (!draft) return null;
  const tryResolve = (resolve: () => ResolvedModelSource | null): ResolvedModelSource | null => {
    try {
      return resolve();
    } catch {
      return null; // not allowlisted: one fewer vote
    }
  };
  let panel: PanelMember[];
  if ((await platformSetting(db, 'knowledge.global_panel')) === 'registry') {
    panel = (await loadRegistry()).flatMap((m) => {
      const s = tryResolve(() => resolveModelSourceFromEnv(env, toModelIdentity(m)));
      return s ? [{ id: m.modelId, source: s }] : [];
    });
  } else {
    const tiers: ModelTier[] = ['quality', 'balanced', 'cheap'];
    panel = tiers.flatMap((t) => {
      const s = tryResolve(() => resolveModelSourceFromEnv(env, t));
      return s ? [{ id: `${t}:${s.model.id}`, source: s }] : [];
    });
  }
  return panel.length > 0 ? { draftModel: draft, panelModels: panel } : null;
}

/** Model-driven background jobs: CI and issue analysis, post-merge follow-ups, learning and memory. */
export function agentHandlers(rt: RunnerRuntime): Record<string, JobHandler> {
  const {
    db,
    logger,
    platformModels,
    buildProviderForRepository,
    openCodePlane,
    openDefaultBranch,
    repositoryReadToken,
  } = rt;
  return {
    pipeline_analyze: createPipelineAnalyzeHandler({
      buildEnv: async ({ payload, changeRequest }) => {
        // Check the model source first so an unconfigured env does not fetch changed files for nothing.
        const source = platformModels.source();
        if (!source)
          notWired('pipeline_analyze 的模型来源(设 LLM_PROVIDER/LLM_MODEL/LLM_BASE_URL/LLM_API_KEY)');
        const provider = await buildProviderForRepository(payload.repositoryId);
        // A CI diagnosis only adds value when it lands on the code changed here.
        const changedFiles = await provider.changes.listChangedFiles(changeRequest);
        const changedPaths = new Set(
          changedFiles.map((f) => f.newPath ?? f.oldPath ?? '').filter(Boolean),
        );
        const cfg = await loadEffectiveConfig(db, payload.tenantId, payload.repositoryId);
        return {
          provider,
          changed: { isChangedFile: (path: string) => changedPaths.has(path) },
          model: source.model,
          streamFn: source.streamFn,
          language: cfg.language,
        };
      },
    }),
    issue_enrich: createIssueEnrichHandler({
      buildEnv: async ({ payload }) => {
        const provider = await buildProviderForRepository(payload.repositoryId);
        const row = await db
          .selectFrom('repositories')
          .selectAll()
          .where('id', '=', payload.repositoryId)
          .executeTakeFirstOrThrow();
        const source = platformModels.source();
        if (!source)
          notWired('issue_enrich 的模型来源(设 LLM_PROVIDER/LLM_MODEL/LLM_BASE_URL/LLM_API_KEY)');
        const cfg = await loadEffectiveConfig(db, payload.tenantId, payload.repositoryId);
        return {
          provider,
          repo: repositoryRefFromRow(row),
          model: source.model,
          streamFn: source.streamFn,
          language: cfg.language,
        };
      },
    }),
    post_merge_action: createPostMergeHandler({
      // Only actions whose executor is wired; the others throw configuration_invalid and would always fail.
      // changelog is folded into update-docs so one merge opens one CR.
      enabledActions: ['update-docs', 'create-follow-up-issue'],
      // Changed files via the provider API (no clone); the handler treats a failure as an empty set.
      listChangedFiles: async ({ repositoryId, changeRequestId }) => {
        const cr = await db
          .selectFrom('change_requests')
          .select(['id', 'native_id', 'number', 'kind'])
          .where('id', '=', changeRequestId)
          .executeTakeFirst();
        if (!cr) return [];
        const provider = await buildProviderForRepository(repositoryId);
        const files = await provider.changes.listChangedFiles({
          id: cr.id,
          repositoryId,
          nativeId: cr.native_id,
          number: cr.number,
          kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
        });
        return files.map((f) => f.newPath ?? f.oldPath ?? '').filter(Boolean);
      },
      executeAction: createPostMergeExecutor({
        buildProvider: buildProviderForRepository,
        openRepository: openDefaultBranch,
        modelSource: () => platformModels.source(),
        log: (m, d) => logger.info(d ?? {}, m),
      }),
    }),
    global_learning_propose: createGlobalLearningProposeHandler({
      resolveModels: (jobDb) => resolveGlobalLearningModels(jobDb, platformModels),
    }),
    // Per-repo switch; the handler returns early without a model.
    learning_propose: createLearningProposeHandler({
      resolveModel: (tier) => platformModels.source(tier),
    }),
    // Per-repo switch; the handler returns early without a model.
    memory_propose: createMemoryProposeHandler({
      resolveModel: (tier) => platformModels.source(tier),
    }),
    // Facts verified online during review are proposed; a platform operator approves them.
    ecosystem_fact_propose: createEcosystemFactProposeHandler({
      resolveModel: (tier) => platformModels.source(tier),
    }),
    // Triggered when a proposal pushes the memory index past its limit.
    memory_consolidate: createMemoryConsolidateHandler({
      resolveModel: (tier) => platformModels.source(tier),
    }),
    // Read-only analysis of the consumer repo; opens an issue and hints on the producer PR.
    cross_repo_analyze: createCrossRepoAnalyzeHandler({
      resolveModel: (tier) => platformModels.source(tier),
      // A shallow workspace of the consumer repository (on a sandbox host with the agent pool).
      openRepository: async (repo) =>
        openCodePlane({
          cloneUrl: repo.cloneUrl,
          token: await repositoryReadToken(repo.installationId, repo.nativeId),
          depth: 1,
        }),
      buildProvider: (repositoryId) => buildProviderForRepository(repositoryId),
    }),
  };
}
