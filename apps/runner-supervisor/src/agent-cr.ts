import { buildSourceTools, languageInstruction, type Model, type StreamFn } from '@reviewbot/agent-pi';
import { createAgentFixProducer, deliverStackedChangeRequest, runFixPipeline, type FixPlan } from '@reviewbot/autofix';
import type { RepositoryRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import type { SandboxBackend } from '@reviewbot/sandbox';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { CodePlaneReader, type CodePlane } from '@reviewbot/review-runtime';
import { resolveBotCommitIdentity } from './bot-identity.js';
import { JobExecutionError } from './supervisor.js';

/** No sandbox validation yet; the agent only reads source to produce the patch. */
const NOOP_BACKEND = {
  create: async () => ({ id: 'agent-cr', containerId: 'agent-cr' }),
  exec: async () => {
    throw new Error('agent-cr runs no validation commands');
  },
  destroy: async () => undefined,
} as unknown as SandboxBackend;

export interface DeliverAgentCrParams {
  provider: SourceControlProvider;
  repo: RepositoryRef;
  /** Opens a tree workspace of the default branch head (scoped read token; a sandbox host with the agent pool). */
  openWorkspace: () => Promise<CodePlane>;
  model: { model: Model<string>; streamFn: StreamFn };
  /** Agent task context (implement an Issue / update docs / changelog …). */
  agentContext: string;
  /** Language of generated docs/changelog/commit text; omitted means English. Identifiers unaffected. */
  language?: string;
  /** Used for the bot branch name (winnowl/{changeNumber}/{actionId}). */
  changeNumber: string | number;
  actionId: string;
  /** Idempotency key for provider.changes.create. */
  idempotencyKey: string;
  title: string;
  body: string;
  /** Prefix for failure diagnostics. */
  label: string;
  /**
   * Return `null` instead of throwing when the agent changes nothing (post-merge). Default false for
   * issue→CR: the user asked for a change, so an empty result is a failure there.
   */
  allowNoChange?: boolean;
  /** Action-plan execution lease guard for branch push and change-request creation. */
  assertLease?: () => Promise<void>;
}

/**
 * Generic "agent change → new CR off the default branch" delivery, shared by issue→CR and post-merge.
 * The patch is applied in the workspace (execution plane); the control plane commits through the
 * provider API. Reuses autofix delivery primitives (V4A / markdown fences / workflow stripping).
 */
export async function deliverAgentCr(params: DeliverAgentCrParams): Promise<{ number: number; url?: string } | null> {
  const plane = await params.openWorkspace();
  try {
    const baseSha = plane.info.headSha;
    const source = new CodePlaneReader(plane).source; // full repo, read-only

    const fixPlan: FixPlan = {
      kind: 'autofix',
      findingIds: [],
      constraints: ['Do not modify GitHub Actions workflow files under .github/workflows/ — out of scope.'],
      expectedFiles: [],
      publicApiChangesAllowed: false,
      validationCommands: [],
    };
    const produceFix = createAgentFixProducer({
      model: params.model.model,
      streamFn: params.model.streamFn,
      readTools: buildSourceTools(source),
      context: params.agentContext + languageInstruction(params.language, 'documentation, changelog and PR/commit prose'),
    });

    let capturedPatch = '';
    const outcome = await runFixPipeline({
      plan: fixPlan,
      backend: NOOP_BACKEND,
      spec: {} as never,
      produceFix,
      storePatch: async (patch) => {
        capturedPatch = patch;
        return { id: uuidv7(), storageKey: 'inline', sha256: '', bytes: patch.length };
      },
      branchWriteConfirmed: true,
      changeNumber: params.changeNumber,
      actionId: params.actionId,
      baseHeadSha: baseSha,
    });

    /*
     * Two kinds of empty result: the pipeline finished with no modified files → the agent's verdict is
     * "no change"; anything else (wrong delivery type, no stacked info) is a real failure and throws.
     */
    const noEdits = !capturedPatch.trim() && outcome.result.modifiedFiles.length === 0;
    if (noEdits && params.allowNoChange) return null;
    if (outcome.delivery.delivery !== 'stacked-change-request' || !outcome.stacked || !capturedPatch.trim()) {
      throw new JobExecutionError(`${params.label} agent 未产可交付 patch`, 'internal_bug', false);
    }

    const residual = outcome.result.residualRisks.length ? `\n\nResidual risks: ${outcome.result.residualRisks.join('; ')}` : '';
    const commits = params.provider.commits;
    if (!commits) {
      throw new JobExecutionError(`${params.label}: provider ${params.provider.kind} cannot commit through its API`, 'configuration_invalid', false);
    }
    try {
      // The patch is applied where the workspace is; only the resulting files come back.
      const changes = await plane.client.applyPatch(capturedPatch);
      return await deliverStackedChangeRequest(
        {
          commitChanges: (input) => commits.commitChanges(params.repo, input),
          ...(params.assertLease ? { assertLease: params.assertLease } : {}),
          openChangeRequest: async (input) => {
            const receipt = await params.provider.changes.create(
              params.repo,
              { title: input.title, body: { markdown: input.body }, sourceBranch: input.sourceBranch, targetBranch: input.targetBranch },
              { key: params.idempotencyKey },
            );
            return { number: receipt.ref.number, ...(receipt.url ? { url: receipt.url } : {}) };
          },
        },
        {
          changes,
          branch: outcome.stacked.branch,
          baseSha,
          targetBranch: params.repo.defaultBranch,
          title: params.title,
          body: `${params.body}${residual}`,
          botIdentity: await resolveBotCommitIdentity(params.provider),
        },
      ).then((r) => r.changeRequest);
    } catch (err) {
      const preview = capturedPatch.slice(0, 500).replace(/\n/g, '\\n');
      throw new JobExecutionError(`${params.label} 交付失败: ${(err as Error).message} | patch[0:500]=${preview}`, 'internal_bug', false);
    }
  } finally {
    await plane.dispose();
  }
}
