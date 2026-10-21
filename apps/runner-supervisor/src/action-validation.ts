import { evaluatePolicy, type ActionPlan, type ActionRepoPolicy } from '@reviewbot/actions';
import type { Db } from '@reviewbot/db';
import type { RepositoryPermission } from '@reviewbot/provider-contracts';
import { ROLE_PERMISSIONS, type Role } from '@reviewbot/rbac';
import type { ActorPermissionResolver } from './review-permissions.js';
import { REVIEW_MANAGE_PERMISSIONS } from './review-permissions.js';

export interface ActionPlanValidationResult {
  ok: boolean;
  reason?: string;
}

export interface ActionPlanValidationDeps {
  /** Provider permission of a user on a repo (re-checked at execution for `@bot approve` plans). */
  resolveActorPermission?: ActorPermissionResolver;
}

/**
 * Re-checks mutable authorization and repo state before an external action. The approval channel decides
 * what: console approvals check tenant membership; `@bot approve` comments check provider write access
 * (the commenter may never have logged into the console).
 */
export async function validateActionPlanExecution(
  db: Db,
  tenantId: string,
  plan: ActionPlan,
  deps: ActionPlanValidationDeps = {},
): Promise<ActionPlanValidationResult> {
  const conversation = await db
    .selectFrom('conversations')
    .select(['repository_id', 'change_request_id'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', plan.conversationId)
    .executeTakeFirst();
  if (!conversation?.repository_id)
    return { ok: false, reason: 'conversation repository unavailable' };

  const repository = await db
    .selectFrom('repositories')
    .innerJoin('provider_hosts', 'provider_hosts.id', 'repositories.provider_host_id')
    .select(['repositories.id', 'provider_hosts.base_url'])
    .where('repositories.id', '=', conversation.repository_id)
    .where('repositories.tenant_id', '=', tenantId)
    .where('provider_hosts.tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (!repository) return { ok: false, reason: 'repository tenant binding invalid' };

  if (plan.revisionSha) {
    if (!conversation.change_request_id) return { ok: false, reason: 'current head unavailable' };
    const current = await db
      .selectFrom('change_requests as cr')
      .innerJoin('revisions as rev', (join) =>
        join
          .onRef('rev.change_request_id', '=', 'cr.id')
          .onRef('rev.tenant_id', '=', 'cr.tenant_id'),
      )
      .select('rev.head_sha')
      .where('cr.id', '=', conversation.change_request_id)
      .where('cr.tenant_id', '=', tenantId)
      .where('cr.repository_id', '=', repository.id)
      .orderBy('rev.created_at', 'desc')
      .executeTakeFirst();
    if (!current) return { ok: false, reason: 'current head unavailable' };
    if (current.head_sha !== plan.revisionSha) return { ok: false, reason: 'head changed' };
  }

  const settings = await db
    .selectFrom('repository_settings')
    .select('settings')
    .where('tenant_id', '=', tenantId)
    .where('repository_id', '=', repository.id)
    .executeTakeFirst();
  const raw = (settings?.settings ?? {}) as {
    actions?: {
      autofix?: { enabled?: boolean; require_confirmation?: boolean };
      create_issue?: { enabled?: boolean; require_confirmation?: boolean };
    };
    merge_gate?: { enabled?: boolean };
  };
  const repoPolicy: ActionRepoPolicy = {
    autofix: {
      enabled: raw.actions?.autofix?.enabled ?? true,
      requireConfirmation: raw.actions?.autofix?.require_confirmation ?? true,
    },
    createIssue: {
      enabled: raw.actions?.create_issue?.enabled ?? true,
      requireConfirmation: raw.actions?.create_issue?.require_confirmation ?? true,
    },
    mergeGovernanceEnabled: raw.merge_gate?.enabled ?? false,
  };

  const approval = plan.approval;
  const actorId = plan.approvalActor === 'any-authorized' ? plan.approvedByActorId : plan.actorId;
  let actorIsRepoAdmin = false;
  if (plan.requiredPermissions.length > 0 || approval?.source === 'provider-comment') {
    if (!actorId) return { ok: false, reason: 'approving actor unavailable' };
    if (approval?.source === 'provider-comment') {
      /*
       * Comment approval: re-check the approver's provider write access, and that the approval belongs to this
       * repo's forge (actor ids collide across forges).
       */
      if (approval.host !== repository.base_url)
        return { ok: false, reason: 'approval host mismatch' };
      if (!deps.resolveActorPermission) return { ok: false, reason: 'actor permission unavailable' };
      const permission = await deps
        .resolveActorPermission(repository.id, {
          login: approval.login,
          providerUserId: approval.actorId,
        })
        .catch(() => 'none' as RepositoryPermission);
      if (!REVIEW_MANAGE_PERMISSIONS.has(permission))
        return { ok: false, reason: 'approving actor lost write access' };
      actorIsRepoAdmin = true;
    } else {
      const membership = await db
        .selectFrom('user_identities as identity')
        .innerJoin('memberships as membership', 'membership.user_id', 'identity.user_id')
        .select('membership.role')
        .where('identity.kind', '=', 'provider')
        .where('identity.issuer', '=', repository.base_url)
        .where('identity.subject', '=', actorId)
        .where('membership.tenant_id', '=', tenantId)
        .where('membership.status', '=', 'active')
        .executeTakeFirst();
      if (!membership || !(membership.role in ROLE_PERMISSIONS))
        return { ok: false, reason: 'actor permission invalid' };
      const permissions = new Set<string>(ROLE_PERMISSIONS[membership.role as Role]);
      if (!plan.requiredPermissions.every((permission) => permissions.has(permission)))
        return { ok: false, reason: 'actor permission invalid' };
      actorIsRepoAdmin = permissions.has('action:approve');
    }
  }

  for (const action of plan.actions) {
    const decision = evaluatePolicy({ action: action.type, actorIsRepoAdmin, repoPolicy });
    if (!decision.allowed) return { ok: false, reason: 'repo policy denies' };
    if (decision.requiresConfirmation && !plan.requiredPermissions.includes('action:approve'))
      return { ok: false, reason: 'repo policy now requires confirmation' };
  }
  return { ok: true };
}
