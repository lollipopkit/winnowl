import {
  planPostMergeActions,
  type PostMergeAction,
  type PostMergeActionKind,
} from '@reviewbot/post-merge';
import { platformSetting } from '@reviewbot/config';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import { JobExecutionError, type JobHandler, type JobHandlerDb } from './supervisor.js';

export interface PostMergePayload {
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
}

export interface PostMergeActionContext {
  action: PostMergeAction;
  repositoryId: string;
  changeRequestId: string;
  /** Files this merge changed; the executor needs them to judge whether e.g. docs must change. */
  changedFiles: string[];
  db: JobHandlerDb;
}

export interface PostMergeDeps {
  /** Post-merge actions enabled for the repository. */
  enabledActions: PostMergeActionKind[];
  /** Executes one post-merge action (injected). */
  executeAction: (ctx: PostMergeActionContext) => Promise<void>;
  /**
   * Changed file paths of the merged CR via the provider API. Omitted/throwing → empty set, so only
   * file-independent actions run instead of failing the job.
   */
  listChangedFiles?: (ctx: { repositoryId: string; changeRequestId: string }) => Promise<string[]>;
}

/** post_merge_action: actions after a default-branch merge; code changes go through a new CR. */
export function createPostMergeHandler(deps: PostMergeDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as PostMergePayload;
    /*
     * Disabled at platform level (default off): `create-follow-up-issue` is always relevant, so it opened an
     * issue on every merge. Repos enabling `actions.post_merge.enabled` still do not run it unless the
     * `post_merge.enabled` platform setting is 1.
     * TODO(post-merge): remove this setting once relevance is fixed; `actions.post_merge.enabled` alone decides.
     */
    if ((await platformSetting(db, 'post_merge.enabled')) !== '1') {
      log('post-merge disabled platform-wide (post_merge.enabled != 1)', {
        changeRequestId: payload.changeRequestId,
      });
      return;
    }
    if (payload.tenantId !== job.tenantId) {
      throw new JobExecutionError(
        'post_merge_action tenantId mismatch',
        'configuration_invalid',
        false,
      );
    }
    const cr = await db
      .selectFrom('change_requests')
      .select(['target_branch'])
      .where('id', '=', payload.changeRequestId)
      .where('tenant_id', '=', job.tenantId)
      .where('repository_id', '=', payload.repositoryId)
      .executeTakeFirst();
    if (!cr)
      throw new JobExecutionError(
        `change request not found: ${payload.changeRequestId}`,
        'repository_invalid',
        false,
      );
    const repo = await db
      .selectFrom('repositories')
      .select(['default_branch'])
      .where('id', '=', payload.repositoryId)
      .where('tenant_id', '=', job.tenantId)
      .executeTakeFirst();
    if (!repo)
      throw new JobExecutionError(
        `repository not found: ${payload.repositoryId}`,
        'repository_invalid',
        false,
      );

    // Repo config can disable post-merge actions (default off). Validate the job's tenant/repo/CR binding
    // first so an untrusted payload cannot read another repo's config.
    if (
      !(await loadEffectiveConfig(db, job.tenantId, payload.repositoryId)).actions.post_merge
        .enabled
    ) {
      log('post-merge skipped by config', { changeRequestId: payload.changeRequestId });
      return;
    }

    const mergedToDefaultBranch =
      cr.target_branch !== null && cr.target_branch === repo.default_branch;
    // Changed files feed relevance; skipped for non-default-branch merges, which run no actions.
    let changedFiles: string[] = [];
    if (mergedToDefaultBranch && deps.listChangedFiles) {
      try {
        changedFiles = await deps.listChangedFiles({
          repositoryId: payload.repositoryId,
          changeRequestId: payload.changeRequestId,
        });
      } catch (error) {
        log('post-merge changed files unavailable, falling back to empty set', {
          changeRequestId: payload.changeRequestId,
          error: (error as Error).message,
        });
      }
    }
    const plan = planPostMergeActions({
      mergedToDefaultBranch,
      changedFiles,
      enabledActions: deps.enabledActions,
    });
    for (const action of plan.actions) {
      await deps.executeAction({
        action,
        repositoryId: payload.repositoryId,
        changeRequestId: payload.changeRequestId,
        changedFiles,
        db,
      });
    }
    log('post-merge actions', {
      changeRequestId: payload.changeRequestId,
      mergedToDefaultBranch,
      changedFiles: changedFiles.length,
      actions: plan.actions.length,
    });
  };
}
