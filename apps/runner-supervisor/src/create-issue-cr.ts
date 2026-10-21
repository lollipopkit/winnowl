import type { PlannedAction } from '@reviewbot/actions';
import type { Model, StreamFn } from '@reviewbot/agent-pi';
import { loadConversation } from '@reviewbot/conversation';
import type { Db } from '@reviewbot/db';
import type { RepositoryRef } from '@reviewbot/domain';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { loadEffectiveConfig, type CodePlane } from '@reviewbot/review-runtime';
import { deliverAgentCr } from './agent-cr.js';
import { botName, botMention } from '@reviewbot/domain';
import type { ActionExecuteContext } from './action-execute.js';
import { botMessages } from './locale.js';
import { JobExecutionError } from './supervisor.js';

export interface IssueCrDeps {
  db: Db;
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
  openRepository: (repo: RepositoryRef) => Promise<CodePlane>;
  modelSource: () => { model: Model<string>; streamFn: StreamFn } | null;
}

/** create-cr-from-issue delivery. branch-write is already authorized by the confirm endpoint; no sandbox validation yet. */
export function createIssueCrDeliverer(
  deps: IssueCrDeps,
): (action: PlannedAction, ctx: ActionExecuteContext) => Promise<void> {
  return async (action, ctx) => {
    if (action.issueNumber === undefined) {
      throw new JobExecutionError('create-cr-from-issue 缺 issueNumber', 'configuration_invalid', false);
    }
    const conv = await loadConversation(deps.db, ctx.tenantId, ctx.plan.conversationId);
    if (!conv?.repositoryId) {
      throw new JobExecutionError('conversation 未绑定 repository,无法从 Issue 建 CR', 'configuration_invalid', false);
    }
    const repoRow = await deps.db.selectFrom('repositories').selectAll().where('id', '=', conv.repositoryId).executeTakeFirst();
    if (!repoRow) throw new JobExecutionError(`repository not found: ${conv.repositoryId}`, 'repository_invalid', false);

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

    const model = deps.modelSource();
    if (!model) throw new JobExecutionError('issue→CR 需模型来源(设 LLM_*)', 'configuration_invalid', false);

    const provider = await deps.buildProvider(conv.repositoryId);
    const issue = await provider.issues.get(repo, action.issueNumber);
    const language = (await loadEffectiveConfig(deps.db, ctx.tenantId, conv.repositoryId)).language;

    await deliverAgentCr({
      provider,
      repo,
      openWorkspace: () => deps.openRepository(repo),
      model,
      agentContext: `Implement the following issue by editing the repository.\n\nIssue #${action.issueNumber}: ${issue.title}\n\n${issue.body ?? ''}\n\n${action.description}`,
      ...(language !== undefined ? { language } : {}),
      changeNumber: `issue-${action.issueNumber}`,
      actionId: ctx.plan.id,
      idempotencyKey: `issue-cr:${ctx.plan.id}`,
      title: botMessages(language).delivery.implementTitle({ bot: botName(), issue: String(action.issueNumber), title: firstLine(issue.title) }),
      body: botMessages(language).delivery.implementBody({ issue: String(action.issueNumber), bot: botMention() }),
      label: 'issue→CR',
      assertLease: ctx.assertLease,
    });
  };
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line || 'issue';
}
