import type { PlannedAction } from '@reviewbot/actions';
import { loadConversation } from '@reviewbot/conversation';
import type { Db } from '@reviewbot/db';
import type { ChangeRequestRef, RepositoryRef } from '@reviewbot/domain';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import type { ActionExecuteContext } from './action-execute.js';
import { JobExecutionError } from './supervisor.js';
import { repositoryRefFromRow } from './repository-ref.js';

export interface ActionExecutorDeps {
  /** Builds an authed Provider for an internal repositoryId. */
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
  /** create-stacked-pr delivery (clone → fix pipeline → stacked CR); injected by wiring/conversation.ts, else the action fails. */
  deliverStackedFix?: (action: PlannedAction, ctx: ActionExecuteContext) => Promise<void>;
  /** create-cr-from-issue delivery (agent patch off the default branch); injected by wiring/conversation.ts, else the action fails. */
  deliverIssueCr?: (action: PlannedAction, ctx: ActionExecuteContext) => Promise<void>;
}

/**
 * Executes actions of an approved ActionPlan. Targets resolve via the plan's conversation binding; every
 * external side effect carries an idempotency key of plan.id + action index so replays do not duplicate.
 * Unsupported actions (e.g. merge governance) fail explicitly (configuration_invalid, no retry).
 */
export function createActionExecutor(
  deps: ActionExecutorDeps,
): (action: PlannedAction, ctx: ActionExecuteContext, index: number) => Promise<void> {
  return async (action, ctx, _index) => {
    switch (action.type) {
      case 'reply':
      case 'explain':
      case 'search':
      case 'show-config':
      case 'inspect-code': {
        const { provider, changeRequest } = await resolveChangeRequest(deps, ctx);
        await ctx.assertLease();
        await provider.discussions.createTopLevelComment(
          { kind: 'change-request', ref: changeRequest },
          { markdown: action.description },
          { key: ctx.idempotencyKey },
        );
        return;
      }
      // Title = first line of the description, body = the full description. plan-issue is read-only and
      // goes straight to issue_enrich, not through ActionPlan.
      case 'create-issue': {
        const { provider, repo } = await resolveRepository(deps, ctx);
        await ctx.assertLease();
        await provider.issues.create(
          repo,
          {
            title: issueTitle(action.description),
            body: { markdown: action.description },
          },
          { key: ctx.idempotencyKey },
        );
        return;
      }
      case 'create-stacked-pr': {
        if (!deps.deliverStackedFix) {
          throw new JobExecutionError(
            'create-stacked-pr 执行器未接线(需 Fix Pipeline 运行时)',
            'configuration_invalid',
            false,
          );
        }
        await ctx.assertLease();
        await deps.deliverStackedFix(action, ctx);
        return;
      }
      case 'create-cr-from-issue': {
        if (!deps.deliverIssueCr) {
          throw new JobExecutionError(
            'create-cr-from-issue 执行器未接线(需 Fix Pipeline 运行时)',
            'configuration_invalid',
            false,
          );
        }
        await ctx.assertLease();
        await deps.deliverIssueCr(action, ctx);
        return;
      }
      default:
        throw new JobExecutionError(
          `action executor not wired: ${action.type}`,
          'configuration_invalid',
          false,
        );
    }
  };
}

function issueTitle(description: string): string {
  const firstLine = description.split('\n', 1)[0]?.trim() ?? '';
  const title = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  return title.length > 0 ? title : 'ReviewBot action';
}

/** Resolves the repository from the conversation binding and builds its Provider. */
async function resolveRepository(
  deps: ActionExecutorDeps,
  ctx: ActionExecuteContext,
): Promise<{ provider: SourceControlProvider; repo: RepositoryRef }> {
  const conversation = await loadConversation(ctx.db as Db, ctx.tenantId, ctx.plan.conversationId);
  if (!conversation?.repositoryId) {
    throw new JobExecutionError(
      'conversation 未绑定 repository,无法执行动作',
      'configuration_invalid',
      false,
    );
  }
  const row = await (ctx.db as Db)
    .selectFrom('repositories')
    .selectAll()
    .where('id', '=', conversation.repositoryId)
    .where('tenant_id', '=', ctx.tenantId)
    .executeTakeFirst();
  if (!row)
    throw new JobExecutionError(
      `repository not found: ${conversation.repositoryId}`,
      'repository_invalid',
      false,
    );
  const repo = repositoryRefFromRow(row);
  const provider = await deps.buildProvider(conversation.repositoryId);
  return { provider, repo };
}

/** Resolves the CR from the conversation binding and builds its Provider. */
async function resolveChangeRequest(
  deps: ActionExecutorDeps,
  ctx: ActionExecuteContext,
): Promise<{ provider: SourceControlProvider; changeRequest: ChangeRequestRef }> {
  const conversation = await loadConversation(ctx.db as Db, ctx.tenantId, ctx.plan.conversationId);
  if (!conversation?.changeRequestId || !conversation.repositoryId) {
    throw new JobExecutionError(
      'conversation 未绑定 change request,无法执行动作',
      'configuration_invalid',
      false,
    );
  }
  const cr = await (ctx.db as Db)
    .selectFrom('change_requests')
    .select(['id', 'repository_id', 'native_id', 'number', 'kind'])
    .where('id', '=', conversation.changeRequestId)
    .where('tenant_id', '=', ctx.tenantId)
    .where('repository_id', '=', conversation.repositoryId)
    .executeTakeFirst();
  if (!cr)
    throw new JobExecutionError(
      `change request not found: ${conversation.changeRequestId}`,
      'repository_invalid',
      false,
    );
  const changeRequest: ChangeRequestRef = {
    id: cr.id,
    repositoryId: cr.repository_id,
    nativeId: cr.native_id,
    number: cr.number,
    kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
  };
  const provider = await deps.buildProvider(conversation.repositoryId);
  return { provider, changeRequest };
}
