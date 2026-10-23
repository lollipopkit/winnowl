import { resolveModelSourceFromEnv } from '@reviewbot/agent-pi';
import { activeModels, decideForReview, loadStageModelPlans } from '@reviewbot/entitlement';
import { toModelIdentity } from '../platform-models.js';
import { botName, changeRequestHeadRef, isProviderKind } from '@reviewbot/domain';
import { botMessages } from '../locale.js';
import { recordDependencyScan } from '@reviewbot/telemetry';
import { loadPlatformSkills, loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import { createSourceProviderForInstallation } from '@reviewbot/provider-factory';
import { enqueueJob } from '@reviewbot/queue';
import {
  createDescriptionUpdater,
  createReviewBuildEnv,
  extractImageUrls,
  fetchPrImages,
  loadedConfigFromLayers,
  loadRepoConfigFromReader,
  recordCoveredFiles,
  stackRootBranchOf,
  tenantConfigLayers,
} from '@reviewbot/review-runtime';
import { createReviewRevisionHandler } from '../review-revision.js';
import { RunnerSetupError } from '../executor-error.js';
import { ProviderError } from '@reviewbot/provider-contracts';
import { continueReview } from '../review-continue.js';
import { enqueueKnowledgeJobs } from '../knowledge-jobs.js';
import { createAutoIssueProposer } from '../auto-issue.js';
import { createReviewChecksSubmitter } from '../review-checks.js';
import { createReviewFindingsWriter } from '../review-findings.js';
import { createReviewThreadResolver } from '../review-threads.js';
import { createReviewerSuggester } from '../review-reviewers.js';
import { createReviewCostWriter } from '../review-cost.js';
import { platformSetting, readAutoFragmentFromYaml } from '@reviewbot/config';
import { createExplainFindingHandler } from '../explain-finding.js';
import { createReverifyFindingsHandler } from '../reverify-findings.js';
import {
  detectDependencyManifests,
  groupVulnerabilities,
  scanDependencyVulnerabilities,
} from '@reviewbot/security-agent';
import { withWorkspaceScanner } from '../workspace-scan.js';
import type { JobHandler } from '../supervisor.js';
import { repositoryRefFromRow } from '../repository-ref.js';
import { gateOptions, notWired, type RunnerRuntime } from './runtime.js';
import { createReviewQuotaGate } from './review-quota-gate.js';

/** review_revision and the jobs that reuse its build env (explain_finding, reverify_findings). */
export async function reviewHandlers(rt: RunnerRuntime): Promise<Record<string, JobHandler>> {
  const {
    db,
    logger,
    platformModels,
    factoryDeps,
    buildProviderForRepository,
    repoContextForRevision,
    openCodePlane,
    llmRelay,
    workspaceScanDeps,
    repositoryReadToken,
    reviewAck,
    statusComment,
  } = rt;
  /**
   * `.winnowl.yaml` at the commit the review's config comes from (trusted-base.ts: base for a normal PR, the
   * root target branch for a stacked one), read without a clone. `text` null: no file; undefined result: the
   * provider cannot read files.
   */
  const readTrustedConfigFile = async (ctx: {
    payload: { repositoryId: string; revisionId: string; changeRequestId: string };
  }): Promise<{ text: string | null } | undefined> => {
    const repo = await db.selectFrom('repositories').selectAll().where('id', '=', ctx.payload.repositoryId).executeTakeFirstOrThrow();
    const provider = await buildProviderForRepository(ctx.payload.repositoryId);
    const getFile = provider.repositories.getFileContent?.bind(provider.repositories);
    if (!getFile) return undefined;
    const rev = await db.selectFrom('revisions').select('base_sha').where('id', '=', ctx.payload.revisionId).executeTakeFirst();
    if (!rev) return undefined;
    const trustedRef = (await stackRootBranchOf(db, ctx.payload.changeRequestId)) ?? rev.base_sha;
    for (const name of ['.winnowl.yaml', '.winnowl.yml']) {
      const text = await getFile(repositoryRefFromRow(repo), name, trustedRef);
      if (text !== null) return { text };
    }
    return { text: null };
  };
  const loaded = await loadPromptBundles([
    'mapper',
    'reviewer',
    'synthesizer',
    'verifier',
    'refuter',
    'explainer',
  ]);
  const reviewBuildEnv = createReviewBuildEnv({
    // Built-in checklists load once at startup; repository ones are read from the base branch by env.
    skills: await loadPlatformSkills(),
    bundles: {
      mapper: loaded.mapper as PromptBundle,
      reviewer: loaded.reviewer as PromptBundle,
      synthesizer: loaded.synthesizer as PromptBundle,
      verifier: loaded.verifier as PromptBundle,
      refuter: loaded.refuter as PromptBundle,
    },
    botMention: `@${botName()}`,
    openWorkspace: async (ctx, revision) => {
      const repoCtx = await repoContextForRevision(db, ctx.payload.revisionId);
      const provider = isProviderKind(repoCtx.provider) ? repoCtx.provider : undefined;
      // Fork PRs: the head is only reachable through the provider's PR ref on the base repository.
      const headRef = provider ? changeRequestHeadRef(provider, repoCtx.changeRequestNumber) : undefined;
      return openCodePlane({
        cloneUrl: repoCtx.cloneUrl,
        token: await repositoryReadToken(repoCtx.installationId, repoCtx.repositoryNativeId),
        baseSha: revision.baseSha,
        headSha: revision.headSha,
        ...(headRef ? { headRef } : {}),
        ...(revision.stackRootBranch !== undefined ? { stackRootBranch: revision.stackRootBranch } : {}),
      });
    },
    buildDiscussions: async (ctx) => {
      const { installationId } = await repoContextForRevision(db, ctx.payload.revisionId);
      const provider = await createSourceProviderForInstallation(factoryDeps, installationId);
      return provider.discussions;
    },
    fetchCurrentHeadSha: async (ctx) => {
      const row = await db
        .selectFrom('revisions as rev')
        .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
        .innerJoin('repositories as repo', 'repo.id', 'cr.repository_id')
        .select([
          'repo.installation_id as installationId',
          'cr.id as id',
          'cr.repository_id as repositoryId',
          'cr.native_id as nativeId',
          'cr.number as number',
          'cr.kind as kind',
        ])
        .where('rev.id', '=', ctx.payload.revisionId)
        .executeTakeFirstOrThrow();
      const provider = await createSourceProviderForInstallation(factoryDeps, row.installationId);
      const current = await provider.changes.getRevision({
        id: row.id,
        repositoryId: row.repositoryId,
        nativeId: row.nativeId,
        number: row.number,
        kind: row.kind === 'merge-request' ? 'merge-request' : 'pull-request',
      });
      return current.headSha;
    },
    // Writes the summary into the PR description.
    buildDescriptionUpdater: async (ctx) => {
      const { installationId } = await repoContextForRevision(db, ctx.payload.revisionId);
      const provider = await createSourceProviderForInstallation(factoryDeps, installationId);
      const cr = await db
        .selectFrom('revisions as rev')
        .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
        .select([
          'cr.id as id',
          'cr.repository_id as repositoryId',
          'cr.native_id as nativeId',
          'cr.number as number',
          'cr.kind as kind',
        ])
        .where('rev.id', '=', ctx.payload.revisionId)
        .executeTakeFirst();
      if (!cr) return undefined;
      return createDescriptionUpdater(provider.changes, {
        id: cr.id,
        repositoryId: cr.repositoryId,
        nativeId: cr.nativeId,
        number: cr.number,
        kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
      });
    },
    /*
     * Images from the CR body and comments. Only this side knows the provider instance origin, so the
     * allowlist is applied here; image URLs come from the PR author's markdown, so nothing outside it is fetched.
     */
    fetchChangeRequestImages: async (ctx) => {
      const row = await db
        .selectFrom('revisions as rev')
        .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
        .innerJoin('repositories as repo', 'repo.id', 'cr.repository_id')
        .innerJoin('provider_hosts as host', 'host.id', 'repo.provider_host_id')
        .select([
          'repo.installation_id as installationId',
          'host.provider as provider',
          'host.base_url as baseUrl',
          'cr.id as id',
          'cr.repository_id as repositoryId',
          'cr.native_id as nativeId',
          'cr.number as number',
          'cr.kind as kind',
        ])
        .where('rev.id', '=', ctx.payload.revisionId)
        .executeTakeFirst();
      if (!row) return [];
      const provider = await createSourceProviderForInstallation(factoryDeps, row.installationId);
      const ref = {
        id: row.id,
        repositoryId: row.repositoryId,
        nativeId: row.nativeId,
        number: row.number,
        kind: row.kind === 'merge-request' ? ('merge-request' as const) : ('pull-request' as const),
      };
      const body = (await provider.changes.getDescription?.(ref).catch(() => '')) ?? '';
      const urls = extractImageUrls(body);
      if (urls.length === 0) return [];
      return fetchPrImages(urls, { provider: row.provider, instanceOrigin: row.baseUrl });
    },
    /*
     * Per-stage models, intersected with enabled registry models so a disabled model counts as absent.
     * An empty or unset intersection falls back to the registry default.
     */
    resolveStageModels: async (ctx) => {
      if (!ctx.payload.tenantId) return undefined;
      const gate = await decideForReview(db, ctx.payload.tenantId, Date.now(), await gateOptions(db));
      // No stage models while degraded: degrading is about cost, and extra models cost more.
      if (gate.degraded) return undefined;
      const allowed = await activeModels(db);
      // Stage models are configured per plan.
      const planRow = await db
        .selectFrom('plans')
        .select('id')
        .where('key', '=', gate.plan.key)
        .executeTakeFirst();
      if (!planRow) return undefined;
      const plans = await loadStageModelPlans(db, planRow.id, allowed);
      const usable = plans.filter((p) => p.models.length > 0);
      return usable.length > 0
        ? usable.map((p) => ({
            stage: p.stage,
            strategy: p.strategy,
            models: p.models.map(toModelIdentity),
          }))
        : undefined;
    },
    /*
     * Per-run cost cap from the tenant's plan; `0` means unlimited (the internal plan). REVIEW_COST_CAP_USD
     * applies only when the plan has no value, so internal tenants' large PRs are not cut short.
     */
    resolveReviewCostCapUsd: async (ctx) => {
      if (!ctx.payload.tenantId) return undefined;
      const gate = await decideForReview(db, ctx.payload.tenantId, Date.now(), await gateOptions(db));
      return gate.reviewCostCapUsd;
    },
    // The selector is a tier (LLM_MODEL_QUALITY/_CHEAP, else LLM_MODEL) or a registry model; for the latter,
    // baseUrl/apiKey still come from env (keys stay out of the database) and the endpoint allowlist applies.
    modelSource: (selector) => {
      const source = resolveModelSourceFromEnv(process.env, selector);
      if (!source) {
        notWired('review_revision 的模型来源(设 LLM_PROVIDER/LLM_MODEL/LLM_BASE_URL/LLM_API_KEY)');
      }
      return source;
    },
    // Effective model from the tenant's plan; env without a tenant.
    resolveModelSelector: async (ctx) => {
      if (!ctx.payload.tenantId) return undefined;
      const gate = await decideForReview(db, ctx.payload.tenantId, Date.now(), await gateOptions(db));
      // Degraded: ignore tier models and use the platform's cheap tier. The registry has no prices, so the
      // cheapest model within a tier is unknown.
      if (gate.degraded) return gate.effectiveTier;
      // A tier without a model falls back to the tier string.
      return gate.effectiveModel ?? gate.effectiveTier;
    },
    /*
     * Fallbacks: the tier's other enabled models in registry order. The runner switches to the next one when
     * the primary exhausts its retries on a non-rate-limit failure. None while degraded (cost first).
     */
    resolveFallbackModelSelectors: async (ctx) => {
      if (!ctx.payload.tenantId) return [];
      const gate = await decideForReview(db, ctx.payload.tenantId, Date.now(), await gateOptions(db));
      if (gate.degraded) return [];
      return gate.allowedModels
        .filter((m) => m.active && m.modelId !== gate.effectiveModel?.modelId)
        .map(toModelIdentity);
    },
    // When the change touches a dependency manifest or lockfile, osv-scanner reports verified CVEs (no repo code
    // runs) for the agent to turn into dependency findings. `security.dep_scan` = 0 disables it; failures never block the review.
    scanDependencies: async (input) => {
      if ((await platformSetting(db, 'security.dep_scan')) === '0') return undefined;
        // Nothing touched a manifest: no sandbox, no process (the scanner would skip anyway).
        if (detectDependencyManifests(input.changedFiles).length === 0) return undefined;
        logger.info(
          { workspace: input.workspace.location.kind, changedCount: input.changedFiles.length },
          'dependency scan(osv-scanner)开始',
        );
        try {
          const scan = await withWorkspaceScanner(workspaceScanDeps, input.workspace, ({ exec, dir }) =>
            scanDependencyVulnerabilities({
              headDir: dir,
              changedFiles: input.changedFiles,
              exec,
              ...(process.env.OSV_SCANNER_BIN ? { bin: process.env.OSV_SCANNER_BIN } : {}),
              onScan: (info) => {
                logger.info(info, 'dependency scan(osv-scanner)完成');
                recordDependencyScan(info.manifestCount, info.vulnerabilityCount);
              },
            }),
          );
          if (!scan) return undefined;
          // The claim is localized here (runner owns i18n); env.ts decides introduced/blocking from structured results.
          const L = botMessages(input.language).security;
          /*
           * One finding per package version (the fix is always upgrading it). Anchor and fingerprint use
           * `package@version` so an advisory appearing or disappearing does not turn it into another finding.
           */
          return {
            totalCount: scan.totalCount,
            vulnerabilities: groupVulnerabilities(scan.vulnerabilities).map((g) => {
              const version = g.installedVersion ?? '?';
              const single = g.advisories.length === 1 ? g.advisories[0]! : undefined;
              const claim = single
                ? g.fixedVersion
                  ? L.depVulnFixed({ pkg: g.package, version, severity: single.severity, id: single.id, title: single.title, fixed: g.fixedVersion })
                  : L.depVulnNoFix({ pkg: g.package, version, severity: single.severity, id: single.id, title: single.title })
                : g.fixedVersion
                  ? L.depVulnGroupFixed({ pkg: g.package, version, count: g.advisories.length, severity: g.severity, ids: g.advisories.map((a) => a.id).join(', '), fixed: g.fixedVersion })
                  : L.depVulnGroupNoFix({ pkg: g.package, version, count: g.advisories.length, severity: g.severity, ids: g.advisories.map((a) => a.id).join(', ') });
              return {
                package: g.package,
                ...(g.installedVersion ? { installedVersion: g.installedVersion } : {}),
                severity: g.severity,
                advisoryId: `${g.package}@${version}`,
                claim,
                ...(g.manifestPath ? { manifestPath: g.manifestPath } : {}),
              };
            }),
          };
        } catch (err) {
          // A scan failure does not block the review; log it for diagnosis.
          logger.warn({ err: (err as Error)?.message }, 'dependency scan(osv-scanner)失败');
          return undefined;
        }
      },
    // One cross-repo analysis job per consumer; only called when the producer enables cross_repo.analyze.
    onCrossRepoImpact: async (impact) => {
      for (const consumer of impact.consumers) {
        await enqueueJob(db, {
          tenantId: impact.tenantId,
          type: 'cross_repo_analyze',
          payload: {
            tenantId: impact.tenantId,
            sourceRepositoryId: impact.sourceRepositoryId,
            revisionId: impact.revisionId,
            consumer,
            triggers: impact.triggers,
            contractContext: impact.contractContext,
          },
          dedupeKey: `xrepo:${impact.revisionId}:${consumer.repositoryId}`,
        });
      }
    },
  });


  return {
    review_revision: createReviewRevisionHandler({
      buildEnv: reviewBuildEnv,
      ...(llmRelay ? { llmRelay } : {}),
      // Sandbox hosts never get a key: a sandboxed review there needs the relay.
      requireLlmRelay: process.env.SANDBOX_BACKEND === 'agents',
      // Acknowledge right after the gate passes, before clone/LLM.
      acknowledge: async (ctx) => {
        await reviewAck.acknowledge(ctx);
        await statusComment
          .reviewing({
            tenantId: ctx.payload.tenantId,
            repositoryId: ctx.payload.repositoryId,
            changeRequestId: ctx.payload.changeRequestId,
          })
          .catch((err) =>
            logger.warn({ changeRequestId: ctx.payload.changeRequestId, err: (err as Error)?.message }, 'status comment failed'),
          );
      },
      // Blocked by quota or cost cap: neutral check stating the reason and how to recover.
      onBlocked: reviewAck.onBlocked,
      // Final attempt failed: neutral check.
      onTerminalFailure: async (ctx, error) => {
        await reviewAck.onTerminalFailure(ctx, error);
        await statusComment
          .failed(
            {
              tenantId: ctx.payload.tenantId,
              repositoryId: ctx.payload.repositoryId,
              changeRequestId: ctx.payload.changeRequestId,
            },
            error,
          )
          .catch((err) =>
            logger.warn({ changeRequestId: ctx.payload.changeRequestId, err: (err as Error)?.message }, 'status comment failed'),
          );
      },
      // When the stored config disables auto review, the head's `.winnowl.yaml` reviews.auto is read via the
      // provider (no clone) as the authoritative view, so enabling it in yaml takes effect; null keeps the stored one.
      // Large changes are counted via the provider API. A skipped review explains why on the PR, with a checkbox to run it.
      onAutoReviewSkipped: (ctx, skip) =>
        statusComment.skipped(
          {
            tenantId: ctx.payload.tenantId,
            repositoryId: ctx.payload.repositoryId,
            changeRequestId: ctx.payload.changeRequestId,
          },
          skip,
        ),
      listChangedPaths: async (ctx) => {
        const provider = await buildProviderForRepository(ctx.payload.repositoryId);
        const files = await provider.changes.listChangedFiles(ctx.changeRequest);
        // Deleted files have nothing to review.
        return files
          .filter((f) => f.status !== 'deleted')
          .map((f) => f.newPath ?? f.oldPath ?? '')
          .filter((p) => p !== '');
      },
      recheckAutoFromRepoFile: async (ctx) => {
        const file = await readTrustedConfigFile(ctx);
        return file?.text ? readAutoFragmentFromYaml(file.text) : null;
      },
      // Provider errors propagate (the job retries): a guessed runner could bill the platform for a user-paid review.
      resolveRunner: async (ctx) => {
        const file = await readTrustedConfigFile(ctx);
        if (!file) return undefined;
        const layers = await tenantConfigLayers(db, ctx.payload);
        const cfg = file.text !== null ? await loadRepoConfigFromReader(async () => file.text, layers) : loadedConfigFromLayers(layers);
        return cfg.config.sandbox.runner;
      },
      rerunActionsWorkflow: async (ctx) => {
        const last = await db
          .selectFrom('actions_runs')
          .select('github_run_id')
          .where('tenant_id', '=', ctx.payload.tenantId)
          .where('repository_id', '=', ctx.payload.repositoryId)
          .where('change_request_number', '=', ctx.changeRequest.number)
          .where('head_sha', '=', ctx.payload.headSha)
          .where('github_run_id', 'is not', null)
          .orderBy('created_at', 'desc')
          .executeTakeFirst();
        if (!last?.github_run_id) throw new RunnerSetupError('actions-no-rerun', 'no-run');
        const provider = await buildProviderForRepository(ctx.payload.repositoryId);
        if (!provider.pipelines.rerun) throw new RunnerSetupError('actions-no-rerun', 'no-run');
        try {
          const r = await provider.pipelines.rerun({ nativeId: last.github_run_id, repositoryId: ctx.payload.repositoryId });
          return r === 'started' ? 'started' : 'wait';
        } catch (err) {
          if (err instanceof ProviderError && err.status === 403) throw new RunnerSetupError('actions-no-rerun', 'permission');
          throw err;
        }
      },
      quotaGate: createReviewQuotaGate(db),
      // Superseded by a newer head: record usage only and skip all post-publish steps (they need a complete,
      // published result).
      onCancelled: (() => {
        const writeCost = createReviewCostWriter();
        return async (outcome, ctx) => {
          await writeCost(outcome, ctx);
        };
      })(),
      // Findings are written before the summary check run (incremental review, fix, auto-issue and checks read them).
      onOutcome: (() => {
        const writeFindings = createReviewFindingsWriter();
        const writeCost = createReviewCostWriter();
        const proposeAutoIssues = createAutoIssueProposer();
        const submitChecks = createReviewChecksSubmitter({
          buildProvider: buildProviderForRepository,
        });
        const resolveThreads = createReviewThreadResolver({ buildProvider: buildProviderForRepository });
        const suggestReviewers = createReviewerSuggester({ buildProvider: buildProviderForRepository });
        return async (outcome, ctx) => {
          await writeFindings(outcome, ctx);
          /*
           * Record which files this round covered. This must come after the findings write: if that fails and the job
           * retries, a ledger already marking the files as covered would make the retry skip them for good. A ledger
           * write failure is only logged; it must not fail an already-published review.
           */
          if (outcome.coveredFiles?.length && outcome.reviewContractDigest) {
            await recordCoveredFiles({
              db,
              tenantId: ctx.payload.tenantId,
              changeRequestId: ctx.payload.changeRequestId,
              headSha: ctx.payload.headSha,
              files: outcome.coveredFiles,
              reviewContractDigest: outcome.reviewContractDigest,
            }).catch((err) =>
              logger.warn(
                { changeRequestId: ctx.payload.changeRequestId, err: (err as Error)?.message },
                'pr coverage 写入失败',
              ),
            );
          }
          // Thread cleanup is presentation only: a failure is logged and does not fail the review or the check.
          await resolveThreads(outcome, ctx).catch((err) =>
            logger.warn({ changeRequestId: ctx.payload.changeRequestId, err: (err as Error)?.message }, 'resolve finding threads failed'),
          );
          await writeCost(outcome, ctx);
          // Propose issues for preexisting, unrelated problems (needs confirmation; off by default).
          await proposeAutoIssues(outcome, ctx);
          await submitChecks(outcome, ctx);
          const statusTarget = {
            tenantId: ctx.payload.tenantId,
            repositoryId: ctx.payload.repositoryId,
            changeRequestId: ctx.payload.changeRequestId,
          };
          const reviewers = await suggestReviewers(ctx).catch((err) => {
            logger.warn({ changeRequestId: ctx.payload.changeRequestId, err: (err as Error)?.message }, 'suggest reviewers failed');
            return undefined;
          });
          const visible = outcome.findings.filter((f) => !f.suppressed);
          const blockingNow = visible.filter((f) => f.decision.blocking);
          // Every file the ledger still lacks is picked up by the next round. Only those deferred by the
          // round limit make this a review in rounds; the rest (cut off by deadline/cost, a section that
          // did not finish, or never claimed by a scope) should have been reviewed in this run.
          const deferredFiles = outcome.deferredPaths?.length ?? 0;
          const unfinishedFiles = (outcome.unreachedPaths?.length ?? 0) + (outcome.unplannedPaths?.length ?? 0);
          const remainingFiles = deferredFiles + unfinishedFiles;
          // After the coverage write above: the next round starts from the ledger this one left.
          const continuing = await continueReview(db, ctx.payload, outcome).catch((err) => {
            logger.warn({ changeRequestId: ctx.payload.changeRequestId, err: (err as Error)?.message }, 'review auto-continue failed');
            return false;
          });
          await statusComment
            .reviewed(statusTarget, {
              headSha: ctx.payload.headSha,
              blocking: {
                count: outcome.blockingCount ?? blockingNow.length,
                severe: blockingNow.some((f) => f.verdict.severity === 'critical' || f.verdict.severity === 'high'),
              },
              nitpicks: visible.filter((f) => f.decision.kind === 'nit').length,
              incomplete: remainingFiles > 0,
              resultsPosted: outcome.resultsPosted === true,
              files: { reviewed: outcome.coveredPaths?.length ?? 0, deferred: deferredFiles, unfinished: unfinishedFiles },
              ...(continuing ? { continuing } : {}),
              walkthrough: outcome.walkthrough ?? [],
              ...(reviewers ? { reviewers } : {}),
            })
            .catch((err) =>
              logger.warn({ changeRequestId: ctx.payload.changeRequestId, err: (err as Error)?.message }, 'status comment failed'),
            );
          if (ctx.payload.tenantId && ctx.payload.repositoryId) {
            await enqueueKnowledgeJobs(
              db,
              { tenantId: ctx.payload.tenantId, repositoryId: ctx.payload.repositoryId, revisionId: ctx.payload.revisionId },
              outcome,
            );
          }
        };
      })(),
    }),
    explain_finding: createExplainFindingHandler({
      bundle: loaded.explainer as PromptBundle,
      modelSource: () => {
        const source = platformModels.source();
        if (!source)
          notWired('explain_finding 的模型来源(设 LLM_PROVIDER/LLM_MODEL/LLM_BASE_URL/LLM_API_KEY)');
        return source;
      },
      buildProvider: buildProviderForRepository,
    }),
    // Directed reverify/challenge reuses the review buildEnv and reruns only the Verifier/Refuter.
    reverify_findings: createReverifyFindingsHandler({
      buildEnv: reviewBuildEnv,
      buildProvider: buildProviderForRepository,
    }),
  };
}
