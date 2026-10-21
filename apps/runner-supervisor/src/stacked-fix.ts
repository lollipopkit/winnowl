import { createHash } from 'node:crypto';
import type { PlannedAction } from '@reviewbot/actions';
import {
  buildSourceTools,
  languageInstruction,
  type Model,
  type StreamFn,
} from '@reviewbot/agent-pi';
import { putArtifact, type ArtifactStore } from '@reviewbot/artifacts';
import type { MasterKeyProvider } from '@reviewbot/kms';
import {
  createAgentFixProducer,
  deliverStackedChangeRequest,
  runFixPipeline,
  runTreeValidation,
  scanPatchAdditions,
  stackedIdempotencyKey,
  type FixPlan,
  type SandboxValidationOutcome,
} from '@reviewbot/autofix';
import { platformSetting } from '@reviewbot/config';
import { loadConversation } from '@reviewbot/conversation';
import { loadFindingsForFix } from '@reviewbot/finding-lifecycle';
import type { Db } from '@reviewbot/db';
import type { ChangeRequestRef, RepositoryRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { changeRequestHeadRef, isProviderKind } from '@reviewbot/domain';
import { CodePlaneReader, loadEffectiveConfig, type CodePlane } from '@reviewbot/review-runtime';
import { applyRepoSandboxPolicy, SANDBOX_PRIORITY, type SandboxBackend, type SandboxSpec } from '@reviewbot/sandbox';
import type { ActionExecuteContext } from './action-execute.js';
import { botName, botMention } from '@reviewbot/domain';
import { BADGE } from './badges.js';
import { copyWorkspaceInto, workspacePlacement } from './code-plane.js';
import { detectStacks, growAfterFailure, initialSize, loadSizing, peaksOf, ranOutOfDisk, recordSizing, swapFor, type SizeBounds } from './sandbox-sizing.js';
import { AgentSandbox } from './agent-sandbox.js';
import { buildAgentSandboxTools } from './agent-tools.js';
import { changedFiles, createSandboxFixProducer, validateInSandbox } from './sandbox-fix.js';
import { resolveBotCommitIdentity } from './bot-identity.js';
import { botMessages } from './locale.js';
import { classifyJobError, JobExecutionError } from './supervisor.js';

export interface StackedFixDeps {
  db: Db;
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
  /**
   * Opens a tree workspace of the repository at `headSha` (scoped read-only token; on a sandbox
   * host with the agent pool). The fix agent reads it, the patch is applied in it.
   */
  openRepository: (
    repo: { installationId: string; nativeId: string; cloneUrl: string },
    at: { headSha: string; headRef?: string },
  ) => Promise<CodePlane>;
  modelSource: () => { model: Model<string>; streamFn: StreamFn } | null;
  /** When set, fix patches are persisted as artifacts; otherwise they stay inline only. */
  artifactStore?: ArtifactStore;
  /** When set, artifact content is envelope-encrypted (object storage only sees ciphertext). */
  kek?: MasterKeyProvider;
  /**
   * Optional sandbox validation of the patched tree before delivery; the result is appended to the
   * CR body as a note and never blocks delivery. `registryProxyUrl` is the registry proxy as seen
   * from inside the sandbox (its only way out).
   */
  validationSandbox?: { backend: SandboxBackend; image: string; registryProxyUrl: string; ecosystems?: string[] };
}

/** The fix agent itself runs no sandbox commands. */
const NOOP_BACKEND = {
  create: async () => ({ id: 'stacked-fix', containerId: 'stacked-fix' }),
  exec: async () => {
    throw new Error('stacked-fix skeleton runs no validation commands');
  },
  destroy: async () => undefined,
} as unknown as SandboxBackend;

/**
 * Delivers create-stacked-pr: the fix agent patches the approved head in the workspace, the change
 * is optionally validated, committed to a bot branch via the provider API, and a stacked CR is opened.
 * Branch-write was already confirmed by the confirmation endpoint, hence branchWriteConfirmed=true.
 */
export function createStackedFixDeliverer(
  deps: StackedFixDeps,
): (action: PlannedAction, ctx: ActionExecuteContext) => Promise<void> {
  return async (action, ctx) => {
    const conv = await loadConversation(deps.db, ctx.tenantId, ctx.plan.conversationId);
    if (!conv?.repositoryId || !conv.changeRequestId) {
      throw new JobExecutionError(
        'conversation 未绑定 change request,无法交付 stacked fix',
        'configuration_invalid',
        false,
      );
    }
    const repoRow = await deps.db
      .selectFrom('repositories')
      .selectAll()
      .where('id', '=', conv.repositoryId)
      .where('tenant_id', '=', ctx.tenantId)
      .executeTakeFirst();
    if (!repoRow)
      throw new JobExecutionError(
        `repository not found: ${conv.repositoryId}`,
        'repository_invalid',
        false,
      );
    const crRow = await deps.db
      .selectFrom('change_requests')
      .select([
        'id',
        'repository_id',
        'native_id',
        'number',
        'kind',
        'source_branch',
        'target_branch',
      ])
      .where('id', '=', conv.changeRequestId)
      .where('tenant_id', '=', ctx.tenantId)
      .where('repository_id', '=', conv.repositoryId)
      .executeTakeFirst();
    if (!crRow)
      throw new JobExecutionError(
        `change request not found: ${conv.changeRequestId}`,
        'repository_invalid',
        false,
      );

    const repo: RepositoryRef = {
      id: repoRow.id,
      providerHostId: repoRow.provider_host_id,
      installationId: repoRow.installation_id,
      nativeId: repoRow.native_id,
      namespace: repoRow.namespace,
      name: repoRow.name,
      cloneUrl: repoRow.clone_url,
      defaultBranch: repoRow.default_branch,
    };
    const changeRequest: ChangeRequestRef = {
      id: crRow.id,
      repositoryId: crRow.repository_id,
      nativeId: crRow.native_id,
      number: crRow.number,
      kind: crRow.kind === 'merge-request' ? 'merge-request' : 'pull-request',
    };

    const model = deps.modelSource();
    if (!model)
      throw new JobExecutionError(
        'stacked fix 需模型来源(设 LLM_*)',
        'configuration_invalid',
        false,
      );

    const provider = await deps.buildProvider(conv.repositoryId);
    const revision = await provider.changes.getRevision(changeRequest);
    if (!ctx.plan.revisionSha) {
      throw new JobExecutionError(
        'stacked fix action plan 未绑定 revision SHA',
        'configuration_invalid',
        false,
      );
    }
    if (revision.headSha !== ctx.plan.revisionSha) {
      throw new JobExecutionError(
        `stacked fix action plan 已过期(expected=${ctx.plan.revisionSha}, current=${revision.headSha})`,
        'policy_denied',
        false,
      );
    }
    const approvedHeadSha = ctx.plan.revisionSha;
    // One config snapshot for delivery modes, body language and validation/sandbox policy.
    const repoConfig = await loadEffectiveConfig(deps.db, ctx.tenantId, conv.repositoryId);
    const headRef = isProviderKind(provider.kind) ? changeRequestHeadRef(provider.kind, changeRequest.number) : undefined;
    // The fix agent reads only the approved revision (fork PR heads come via the provider PR ref).
    const plane = await deps.openRepository(
      { installationId: repoRow.installation_id, nativeId: repoRow.native_id, cloneUrl: repoRow.clone_url },
      { headSha: approvedHeadSha, ...(headRef ? { headRef } : {}) },
    );
    let box: AgentSandbox | undefined;
    try {
      const changed = await provider.changes.listChangedFiles(changeRequest);
      const changedPaths = changed.map((f) => f.newPath ?? f.oldPath ?? '').filter(Boolean);
      const source = new CodePlaneReader(
        plane,
        changedPaths.map((path) => ({ path, status: 'modified' as const })),
      ).source;

      const fixPlan: FixPlan = {
        kind: (action.fixKind as FixPlan['kind']) ?? 'autofix',
        findingIds: action.findingIds ?? [],
        // The App has no workflows permission and edits there are a supply-chain risk; delivery strips them too.
        constraints: [
          'Do not modify GitHub Actions workflow files under .github/workflows/ — they are out of scope for autofix.',
        ],
        expectedFiles: changedPaths,
        publicApiChangesAllowed: false,
        validationCommands: [],
      };
      // Finding UUIDs mean nothing to the agent; give it claim + path:line.
      const findingDetails = await loadFindingsForFix(deps.db, action.findingIds ?? []);
      const findingList = findingDetails.length
        ? findingDetails
            .map(
              (f, i) =>
                `${i + 1}. [${f.category}] ${f.claim}${f.path ? ` — ${f.path}${f.line ? `:${f.line}` : ''}` : ''}`,
            )
            .join('\n')
        : '(finding 详情不可用,请依据本次变更文件自行定位并修复问题)';
      const fixContext = `Findings to fix in this pull request:\n${findingList}\n\n${action.description}${languageInstruction(repoConfig.language, 'documentation, changelog, comments and other user-facing prose')}`;
      // Setting `agent.sandbox`: the agent edits and checks its change in a sandbox.
      if (deps.validationSandbox && (await platformSettingOn(deps.db, 'agent.sandbox'))) {
        box = await openRepositorySandbox(deps.validationSandbox, deps.db, plane, repoConfig, {
          tenantId: ctx.tenantId,
          repositoryId: conv.repositoryId,
          jobId: ctx.plan.id,
          task: `Fix findings in pull request #${changeRequest.number} of ${repoRow.namespace}/${repoRow.name}:\n${findingList}`,
          judge: model,
        });
      }
      const produceFix = box
        ? createSandboxFixProducer({
            model: model.model,
            streamFn: model.streamFn,
            box,
            tools: buildAgentSandboxTools(box, changedPaths),
            context: fixContext,
          })
        : createAgentFixProducer({
            model: model.model,
            streamFn: model.streamFn,
            readTools: buildSourceTools(source),
            context: fixContext,
          });

      const deliveryKey = stackedIdempotencyKey({
        baseHeadSha: approvedHeadSha,
        findingIds: fixPlan.findingIds,
        kind: fixPlan.kind,
      });
      const stableActionId = createHash('sha256').update(deliveryKey).digest('hex').slice(0, 20);

      let capturedPatch = '';
      const outcome = await runFixPipeline({
        plan: fixPlan,
        backend: NOOP_BACKEND,
        spec: {} as never,
        produceFix,
        storePatch: async (patch) => {
          // The secret scan must precede any object-storage write; a rejected patch must never become an artifact.
          const secretHits = scanPatchAdditions(patch);
          if (secretHits.length > 0) {
            const kinds = [...new Set(secretHits.map((h) => h.kind))].join(', ');
            throw new JobExecutionError(
              `fix patch 新增内容含疑似密钥(${secretHits.length} 处:${kinds}),已拒绝交付以防泄露`,
              'configuration_invalid',
              false,
            );
          }
          capturedPatch = patch;
          // Persist the patch when object storage is configured; otherwise keep it inline.
          if (deps.artifactStore) {
            return putArtifact(
              deps.db,
              deps.artifactStore,
              {
                tenantId: ctx.tenantId,
                kind: 'fix-patch',
                content: patch,
                contentType: 'text/x-diff',
                ttlDays: 30,
                metadata: { changeRequestId: conv.changeRequestId, actionId: ctx.plan.id },
              },
              deps.kek,
            );
          }
          return { id: uuidv7(), storageKey: 'inline', sha256: '', bytes: patch.length };
        },
        branchWriteConfirmed: true,
        changeNumber: changeRequest.number,
        actionId: stableActionId,
        baseHeadSha: approvedHeadSha,
        allowedDeliveries: repoConfig.actions.autofix.delivery,
      });

      // Stacked delivery disabled by config is a configuration error: no retry, and name the config key.
      if (outcome.delivery.delivery !== 'stacked-change-request' || !outcome.stacked) {
        throw new JobExecutionError(
          `stacked PR 交付未被仓库配置允许(actions.autofix.delivery=${JSON.stringify(repoConfig.actions.autofix.delivery)})`,
          'configuration_invalid',
          false,
        );
      }
      if (!capturedPatch.trim()) {
        throw new JobExecutionError('fix agent 未产可交付 patch', 'internal_bug', false);
      }

      const residual = outcome.result.residualRisks.length
        ? `\n\nResidual risks: ${outcome.result.residualRisks.join('; ')}`
        : '';
      const language = repoConfig.language;
      const crBody = botMessages(language).delivery.autofixBody({
        findings: (action.findingIds ?? []).join(', ') || '(none)',
        residual,
        bot: botMention(),
      });
      const commits = provider.commits;
      if (!commits) {
        throw new JobExecutionError(`provider ${provider.kind} cannot commit through its API`, 'configuration_invalid', false);
      }
      try {
        // The patch is applied where the workspace is; only the resulting files come back.
        const changes = await plane.client.applyPatch(capturedPatch);
        const validationNote = box
          ? await validateBox(box, repoConfig, language, changedFiles(capturedPatch))
          : deps.validationSandbox && (await fixValidationEnabled(deps.db))
            ? await validateWorkspace(
                deps.validationSandbox,
                deps.db,
                { tenantId: ctx.tenantId, repositoryId: conv.repositoryId },
                plane,
                repoConfig,
                language,
              )
            : undefined;
        await deliverStackedChangeRequest(
          {
            assertLease: ctx.assertLease,
            commitChanges: (input) => commits.commitChanges(repo, input),
            openChangeRequest: async (input) => {
              const receipt = await provider.changes.create(
                repo,
                {
                  title: input.title,
                  body: { markdown: input.body },
                  sourceBranch: input.sourceBranch,
                  targetBranch: input.targetBranch,
                },
                { key: outcome.stacked!.idempotencyKey },
              );
              return { number: receipt.ref.number, ...(receipt.url ? { url: receipt.url } : {}) };
            },
          },
          {
            changes,
            branch: outcome.stacked.branch,
            baseSha: approvedHeadSha,
            targetBranch: crRow.source_branch ?? repoRow.default_branch,
            title: botMessages(language).delivery.fixTitle({
              bot: botName(),
              desc: firstLine(action.description),
            }),
            body: crBody,
            ...(validationNote ? { validationNote } : {}),
            botIdentity: await resolveBotCommitIdentity(provider),
          },
        );
      } catch (err) {
        throw deliveryFailure(err, capturedPatch);
      }
    } finally {
      await box?.close().catch(() => undefined);
      await plane.dispose();
    }
  };
}

/**
 * Already-classified errors (JobExecutionError: lost lease, policy denial, ...) are rethrown as-is so
 * retryable ones stay retryable; the rest are classified generically, with a patch preview appended
 * (a patch that does not apply is the most common failure).
 */
export function deliveryFailure(err: unknown, capturedPatch: string): JobExecutionError {
  if (err instanceof JobExecutionError) return err;
  const preview = capturedPatch.slice(0, 500).replace(/\n/g, '\\n');
  const { failureClass, retryable } = classifyJobError(err);
  return new JobExecutionError(
    `stacked fix 交付失败: ${(err as Error).message} | patch[0:500]=${preview}`,
    failureClass,
    retryable,
  );
}

/**
 * Platform setting `fix.validation`, read on every delivery so an operator's switch applies to the
 * next one. A failed read falls back to env / default (a database blip must not change delivery).
 */
export function fixValidationEnabled(db: Db): Promise<boolean> {
  return platformSettingOn(db, 'fix.validation');
}

/** An on/off platform setting, read afresh (a failed read falls back to env / default). */
export async function platformSettingOn(db: Db, key: 'fix.validation' | 'agent.sandbox'): Promise<boolean> {
  return (await platformSetting(db, key)) === 'on';
}

/**
 * An agent sandbox on a repository tree (the fix agent's, and `run <command>`'s): the validation image and
 * network, sized from what the repository needed. `jobId` scopes the command audit.
 */
export async function openRepositorySandbox(
  validation: NonNullable<StackedFixDeps['validationSandbox']>,
  db: Db,
  plane: CodePlane,
  repoConfig: Awaited<ReturnType<typeof loadEffectiveConfig>>,
  o: { tenantId: string; repositoryId: string; jobId: string; task: string; judge: { model: Model<string>; streamFn: StreamFn } },
): Promise<AgentSandbox> {
  const { limited, bounds } = validationLimits(validation, plane, repoConfig);
  const readFile = async (rel: string): Promise<string | null> => (await plane.client.readFiles([rel]))[rel] ?? null;
  const measured =
    (await loadSizing(db, o.repositoryId, 'agent').catch(() => undefined)) ??
    (await loadSizing(db, o.repositoryId, 'validation').catch(() => undefined));
  const size = initialSize(measured, await detectStacks(readFile), bounds);
  return AgentSandbox.open({
    backend: validation.backend,
    spec: { ...limited, priority: SANDBOX_PRIORITY.validation, maxLifetimeSeconds: 90 * 60 },
    deliverTree: (handle, dest) => copyWorkspaceInto(validation.backend, handle, plane, dest),
    base: { cpus: 1, memoryMb: Math.min(1024, size.memoryMb) },
    work: { cpus: limited.resources.cpus, memoryMb: size.memoryMb },
    diskMb: size.diskMb,
    bounds,
    task: o.task,
    judge: o.judge,
    db,
    audit: { tenantId: o.tenantId, jobId: o.jobId, repositoryId: o.repositoryId },
    sizing: { tenantId: o.tenantId, repositoryId: o.repositoryId },
  });
}

/** Validation in the agent's own sandbox, rendered like the separate validation's note. */
async function validateBox(
  box: AgentSandbox,
  repoConfig: Awaited<ReturnType<typeof loadEffectiveConfig>>,
  language: string | undefined,
  changed: readonly string[],
): Promise<string> {
  const L = botMessages(language).delivery;
  try {
    return renderValidationNote(L, await validateInSandbox(box, box.source([]).readFile, repoConfig.tools, changed));
  } catch (e) {
    return `${BADGE.sandbox} ${L.validationHeading()}: ⚠️ ${(e as Error).message}`;
  }
}

/**
 * Runs install, lint, build and test on the patched workspace, in a sandbox on the workspace host,
 * and returns a localized note for the CR body. Failures never block delivery.
 */
async function validateWorkspace(
  validation: NonNullable<StackedFixDeps['validationSandbox']>,
  db: Db,
  scope: { tenantId: string; repositoryId: string },
  plane: CodePlane,
  repoConfig: Awaited<ReturnType<typeof loadEffectiveConfig>>,
  language: string | undefined,
): Promise<string> {
  const L = botMessages(language).delivery;
  try {
    const readFile = async (rel: string): Promise<string | null> => (await plane.client.readFiles([rel]))[rel] ?? null;
    /*
     * Sized from what this repository's last validations used, else its ecosystem default; an OOM kill
     * or full disk grows the sandbox in place and reruns once. The env values are the ceilings.
     * Tree and toolchain caches live on the host's disk-quota slot, so memory is for processes only;
     * without slots (local development) the disk is an unlimited docker volume and cannot grow.
     */
    const { limited, bounds } = validationLimits(validation, plane, repoConfig);
    const measured = await loadSizing(db, scope.repositoryId, 'validation').catch(() => undefined);
    const start = initialSize(measured, await detectStacks(readFile), bounds);
    const spec: SandboxSpec = {
      ...limited,
      resources: { ...limited.resources, memoryMb: start.memoryMb, swapMb: swapFor(start.memoryMb), diskMb: start.diskMb },
    };
    const outcome = await runTreeValidation({
      backend: validation.backend,
      spec,
      deliverTree: (handle, dest) => copyWorkspaceInto(validation.backend, handle, plane, dest),
      readFile,
      // Explicit commands override auto-detection for the same stage; auto_detect=false runs only explicit ones.
      tools: repoConfig.tools,
      grow: (handle, res) =>
        growAfterFailure(
          validation.backend,
          handle,
          { oomKilled: res.oomKilled === true, outOfDisk: ranOutOfDisk(`${res.stdout}\n${res.stderr}`) },
          bounds,
        ),
      beforeDestroy: async (handle) => {
        if (!validation.backend.usage) return;
        await recordSizing(db, { ...scope, kind: 'validation' }, peaksOf(await validation.backend.usage(handle)));
      },
    });
    return renderValidationNote(L, outcome);
  } catch (e) {
    // A failure of validation itself does not block delivery; its cause goes into the note.
    return `${BADGE.sandbox} ${L.validationHeading()}: ⚠️ ${(e as Error).message}`;
  }
}

/**
 * The ceiling of a validation-image sandbox (env values), tightened by the repository `sandbox`
 * config (which can only tighten), and the bounds a measured size is kept within.
 */
function validationLimits(
  validation: NonNullable<StackedFixDeps['validationSandbox']>,
  plane: CodePlane,
  repoConfig: Awaited<ReturnType<typeof loadEffectiveConfig>>,
): { limited: SandboxSpec; bounds: SizeBounds } {
  const eco = validation.ecosystems ?? ['npm', 'pypi', 'cargo', 'go', 'dart', 'flutter', 'github'];
  const ceiling: SandboxSpec = {
    image: validation.image,
    network: { mode: 'package-registry-only', ecosystems: eco },
    env: proxyEnv(validation.registryProxyUrl),
    resources: {
      cpus: Number(process.env.VALIDATION_SANDBOX_CPUS) || 2,
      memoryMb: Number(process.env.VALIDATION_SANDBOX_MEMORY_MB) || 6144,
      pids: Number(process.env.VALIDATION_SANDBOX_PIDS) || 1024,
      diskMb: Number(process.env.VALIDATION_SANDBOX_DISK_MB) || 16384,
      workspace: 'disk',
    },
    // The repository's build runs what it compiles (build scripts, test binaries).
    writableExec: true,
    priority: SANDBOX_PRIORITY.validation,
    maxLifetimeSeconds: 20 * 60,
    ...(process.env.REVIEW_SANDBOX_RUNTIME ? { runtime: process.env.REVIEW_SANDBOX_RUNTIME } : {}),
    ...workspacePlacement(plane),
  };
  // Repo `sandbox` config can only tighten the platform baseline; a repo claiming `full` network
  // is not admin approval, and resources cannot exceed the env ceiling.
  const limited = applyRepoSandboxPolicy(ceiling, repoConfig.sandbox);
  const bounds = {
    minMemoryMb: Math.min(1024, limited.resources.memoryMb),
    maxMemoryMb: limited.resources.memoryMb,
    minDiskMb: Math.min(2048, limited.resources.diskMb),
    maxDiskMb: limited.resources.diskMb,
  };
  return { limited, bounds };
}

/**
 * npm / pip / cargo / go / pub all read these (lower- and upper-case spellings differ per tool).
 * Loopback stays direct: test runners talk to their own harness there (flutter_tester connects to
 * a websocket on 127.0.0.1), which the proxy would refuse.
 */
function proxyEnv(url: string): Record<string, string> {
  const noProxy = 'localhost,127.0.0.1,::1';
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line || 'apply findings';
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Sandbox validation result as a localized markdown note (informational only). */
function renderValidationNote(
  L: ReturnType<typeof botMessages>['delivery'],
  outcome: SandboxValidationOutcome,
): string {
  const total = outcome.results.length;
  if (outcome.status === 'not-run' || total === 0)
    return `${BADGE.sandbox} ${L.validationHeading()}: ${L.validationNotRun()}`;
  const passed = outcome.results.filter((r) => r.passed).length;
  const parts = [
    `${BADGE.sandbox} ${L.validationHeading()} — ${L.validationSummary({ passed, total })}`,
  ];
  if (passed < total) {
    const failedResults = outcome.results.filter((r) => !r.passed);
    parts.push(L.validationFailed({ commands: failedResults.map((r) => `\`${r.command}\``).join(', ') }));
    // Why each one failed: the end of its output, folded (a fence inside would end the block).
    for (const r of failedResults) {
      if (!r.outputTail) continue;
      const tail = r.outputTail.replace(/```/g, "'''");
      parts.push(`<details><summary><code>${escapeHtml(r.command)}</code></summary>\n\n\`\`\`\n${tail}\n\`\`\`\n</details>`);
    }
  }
  return parts.join('\n');
}
