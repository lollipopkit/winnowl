import type { Model, StreamFn } from '@reviewbot/agent-pi';
import type { RepositoryRef } from '@reviewbot/domain';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { loadEffectiveConfig, type CodePlane } from '@reviewbot/review-runtime';
import { deliverAgentCr } from './agent-cr.js';
import { botName } from '@reviewbot/domain';
import type { PostMergeActionContext } from './post-merge.js';
import { botMessages } from './locale.js';
import { JobExecutionError } from './supervisor.js';
import { repositoryRefFromRow } from './repository-ref.js';

export interface PostMergeExecutorDeps {
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
  /** Records outcomes without artifacts (e.g. "no change needed"); otherwise they look like the action never ran. */
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Default-branch workspace for code-changing actions (delivered via a new CR); not injected → they fail. */
  openRepository?: (repo: RepositoryRef) => Promise<CodePlane>;
  modelSource?: () => { model: Model<string>; streamFn: StreamFn } | null;
}

/** Action kind → localized label for crTitle's {kind}. */
function kindLabel(L: ReturnType<typeof botMessages>['postMerge'], kind: string): string {
  switch (kind) {
    case 'update-docs':
      return L.kindUpdateDocs();
    default: // create-follow-up-cr
      return L.kindCreateFollowUpCr();
  }
}

/**
 * Action → agent task. Lists the changed files and states explicitly that changing nothing is fine;
 * otherwise the agent forces a diff on every merge.
 */
function contextFor(kind: string, crNumber: number | string, reason: string, changedFiles: string[]): string {
  // File names only: the agent reads contents itself, and a long list would crowd out the instructions.
  const files = changedFiles.length > 0 ? `\n\nFiles changed in #${crNumber}:\n${changedFiles.slice(0, 60).map((f) => `- ${f}`).join('\n')}${changedFiles.length > 60 ? `\n- …and ${changedFiles.length - 60} more` : ''}` : '';
  switch (kind) {
    case 'update-docs':
      return (
        `Bring the repository's documentation in line with the changes merged in #${crNumber}. ` +
        `That includes the changelog if this repository keeps one, in its existing format. ` +
        `Only edit documentation and changelog files; do not change source behavior.\n\n` +
        `**Making no change is a valid and expected outcome.** Read the docs that cover the areas this change touched. ` +
        `If they already describe the new behavior, or if the change has no user-visible or contributor-visible effect, ` +
        `change nothing and say so. Do not restate what a document already says, and do not add operating instructions ` +
        `to a design or decision record — those documents record why a choice was made, not how to click through a UI. ` +
        `Reason: ${reason}${files}`
      );
    default: // create-follow-up-cr
      return `Make the follow-up code changes after #${crNumber} was merged. Reason: ${reason}${files}`;
  }
}

/**
 * Post-merge action executor. `create-follow-up-issue` → `issues.create`; code-changing actions →
 * `deliverAgentCr` (new CR off the default branch, never writing the default branch directly).
 * `notify-related-repo` is not wired yet and fails explicitly.
 */
export function createPostMergeExecutor(
  deps: PostMergeExecutorDeps,
): (ctx: PostMergeActionContext) => Promise<void> {
  return async (ctx) => {
    const cr = await ctx.db
      .selectFrom('change_requests')
      .select(['number'])
      .where('id', '=', ctx.changeRequestId)
      .executeTakeFirst();
    const crNumber = cr?.number ?? '?';
    // Output language follows repository config; default en.
    const language = await repoLanguage(ctx, ctx.repositoryId);
    const L = botMessages(language).postMerge;
    // Relevance reason localized from the typed reasonCode.
    const reasonText =
      ctx.action.reasonCode === 'contract-change'
        ? L.reasonContractChange()
        : ctx.action.reasonCode === 'migration-change'
          ? L.reasonMigrationChange()
          : L.reasonEnabled();

    if (ctx.action.kind === 'create-follow-up-issue') {
      const repo = await loadRepositoryRef(ctx, ctx.repositoryId);
      const provider = await deps.buildProvider(ctx.repositoryId);
      await provider.issues.create(
        repo,
        {
          title: L.followUpTitle({ cr: String(crNumber) }),
          body: { markdown: L.followUpBody({ reason: reasonText, cr: String(crNumber) }) },
          labels: [botName(), 'follow-up'],
        },
        { key: `post-merge-issue:${ctx.changeRequestId}:${ctx.action.kind}` },
      );
      return;
    }

    if (ctx.action.kind === 'update-docs' || ctx.action.kind === 'create-follow-up-cr') {
      const openRepository = deps.openRepository;
      if (!openRepository || !deps.modelSource) {
        throw new JobExecutionError(`post-merge ${ctx.action.kind} 执行器未接线(需 model/git 运行时)`, 'configuration_invalid', false);
      }
      const model = deps.modelSource();
      if (!model) throw new JobExecutionError(`post-merge ${ctx.action.kind} 需模型来源(设 LLM_*)`, 'configuration_invalid', false);
      const repo = await loadRepositoryRef(ctx, ctx.repositoryId);
      const provider = await deps.buildProvider(ctx.repositoryId);
      const delivered = await deliverAgentCr({
        provider,
        repo,
        openWorkspace: () => openRepository(repo),
        model,
        // System-triggered: "nothing to change" is a valid outcome; forbidding it forces hollow CRs.
        allowNoChange: true,
        agentContext: contextFor(ctx.action.kind, crNumber, ctx.action.reason, ctx.changedFiles),
        ...(language !== undefined ? { language } : {}),
        changeNumber: `postmerge-${crNumber}`,
        actionId: ctx.action.kind,
        idempotencyKey: `post-merge-cr:${ctx.changeRequestId}:${ctx.action.kind}`,
        title: L.crTitle({ bot: botName(), kind: kindLabel(L, ctx.action.kind), cr: String(crNumber) }),
        body: `${L.crBody({ cr: String(crNumber), reason: reasonText })}\n\n${L.reviewNote()}`,
        label: `post-merge ${ctx.action.kind}`,
      });
      if (!delivered) deps.log?.('post-merge 无需改动', { kind: ctx.action.kind, changeRequestId: ctx.changeRequestId });
      return;
    }

    // notify-related-repo is not wired yet.
    throw new JobExecutionError(
      `post-merge 动作执行器未接线:${ctx.action.kind}`,
      'configuration_invalid',
      false,
    );
  };
}

/** Output language from the repository's effective config; undefined (English) when the repo is missing. */
async function repoLanguage(ctx: PostMergeActionContext, repositoryId: string): Promise<string | undefined> {
  const row = await ctx.db.selectFrom('repositories').select('tenant_id').where('id', '=', repositoryId).executeTakeFirst();
  if (!row) return undefined;
  return (await loadEffectiveConfig(ctx.db, row.tenant_id, repositoryId)).language;
}

async function loadRepositoryRef(ctx: PostMergeActionContext, repositoryId: string): Promise<RepositoryRef> {
  const row = await ctx.db.selectFrom('repositories').selectAll().where('id', '=', repositoryId).executeTakeFirst();
  if (!row) throw new JobExecutionError(`repository not found: ${repositoryId}`, 'repository_invalid', false);
  return repositoryRefFromRow(row);
}
