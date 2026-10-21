import type { RepositoryPermission } from '@reviewbot/provider-contracts';

export type ActorPermissionResolver = (
  repositoryId: string,
  actor: { login: string; providerUserId?: string },
) => Promise<RepositoryPermission>;

/**
 * Repo permissions that may manage reviews. `triage` is excluded: it cannot change code, so it must not
 * lift the gate. Shared by conversation-route and action-validation so comment-time and execution-time
 * checks never disagree.
 */
export const REVIEW_MANAGE_PERMISSIONS: ReadonlySet<RepositoryPermission> =
  new Set<RepositoryPermission>(['admin', 'maintain', 'write']);

/**
 * Repo permissions whose words become knowledge without an admin's approval. Narrower than review
 * management: write access is enough to push code, not to steer every later review of the repository.
 */
export const KNOWLEDGE_TRUSTED_PERMISSIONS: ReadonlySet<RepositoryPermission> =
  new Set<RepositoryPermission>(['admin', 'maintain']);
