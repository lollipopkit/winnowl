/** Post-merge actions run as their own job; any code change is delivered through a new PR/MR. */

/** No separate changelog action: `update-docs` covers it, so one merge opens one CR. */
export type PostMergeActionKind =
  | 'update-docs'
  | 'refresh-generated-client'
  | 'create-follow-up-issue'
  | 'run-migration-validation'
  | 'notify-related-repo'
  | 'create-follow-up-cr';

const CODE_MODIFYING: ReadonlySet<PostMergeActionKind> = new Set<PostMergeActionKind>([
  'update-docs',
  'refresh-generated-client',
  'create-follow-up-cr',
]);

/** Typed reason code so the publisher can localize instead of using a pre-rendered string. */
export type PostMergeReasonCode = 'contract-change' | 'migration-change' | 'enabled';

export interface PostMergeAction {
  kind: PostMergeActionKind;
  deliversViaNewChangeRequest: boolean;
  /** Internal/audit only; published text uses `reasonCode`. */
  reason: string;
  reasonCode: PostMergeReasonCode;
}

export interface PostMergeContext {
  mergedToDefaultBranch: boolean;
  changedFiles: string[];
  enabledActions: PostMergeActionKind[];
}

export interface PostMergePlan {
  /** Never reuses the old review session. */
  reusesReviewSession: false;
  actions: PostMergeAction[];
  skipped: { kind: PostMergeActionKind; reason: string }[];
}

const CONTRACT_RE = /\.(proto|graphql|gql)$|(^|\/)(openapi|swagger)\.(ya?ml|json)$/i;
const MIGRATION_RE = /(^|\/)migrations?\//i;

/** Only a merge into the default branch triggers actions. */
export function planPostMergeActions(ctx: PostMergeContext): PostMergePlan {
  if (!ctx.mergedToDefaultBranch) {
    return {
      reusesReviewSession: false,
      actions: [],
      skipped: ctx.enabledActions.map((kind) => ({ kind, reason: '非默认分支 merge' })),
    };
  }

  const actions: PostMergeAction[] = [];
  const skipped: { kind: PostMergeActionKind; reason: string }[] = [];

  for (const kind of ctx.enabledActions) {
    const relevance = isRelevant(kind, ctx.changedFiles);
    if (!relevance.relevant) {
      skipped.push({ kind, reason: relevance.reason });
      continue;
    }
    actions.push({
      kind,
      deliversViaNewChangeRequest: CODE_MODIFYING.has(kind),
      reason: relevance.reason,
      reasonCode: kind === 'refresh-generated-client' ? 'contract-change' : kind === 'run-migration-validation' ? 'migration-change' : 'enabled',
    });
  }

  return { reusesReviewSession: false, actions, skipped };
}

function isRelevant(kind: PostMergeActionKind, changedFiles: string[]): { relevant: boolean; reason: string } {
  switch (kind) {
    case 'refresh-generated-client':
      return changedFiles.some((f) => CONTRACT_RE.test(f))
        ? { relevant: true, reason: '契约面变化,刷新生成客户端' }
        : { relevant: false, reason: '无契约面变化' };
    case 'run-migration-validation':
      return changedFiles.some((f) => MIGRATION_RE.test(f))
        ? { relevant: true, reason: '存在迁移变化,执行校验' }
        : { relevant: false, reason: '无迁移变化' };
    default:
      return { relevant: true, reason: '已启用' };
  }
}
