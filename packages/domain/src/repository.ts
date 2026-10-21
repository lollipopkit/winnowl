import type { ProviderNativeId, Uuid } from './ids.js';
import type { ChangeRequestCapabilities } from './provider.js';

export interface RepositoryRef {
  id: Uuid;
  providerHostId: Uuid;
  installationId: Uuid;
  nativeId: ProviderNativeId;
  namespace: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  /** Omitted when the provider does not report it; billing then treats the repo as private (fail-closed). */
  visibility?: 'public' | 'private';
}

export interface IssueRef {
  id: Uuid;
  repositoryId: Uuid;
  nativeId: ProviderNativeId;
  number: number;
}

export interface ChangeRequestRef {
  id: Uuid;
  repositoryId: Uuid;
  nativeId: ProviderNativeId;
  number: number;
  kind: 'pull-request' | 'merge-request';
}

/** Immutable revision. */
export interface Revision {
  id: Uuid;
  changeRequestId: Uuid;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  startSha?: string;
  sourceBranch: string;
  targetBranch: string;
  sourceRepositoryId?: Uuid;
  createdAt: string;
}

export interface Actor {
  providerUserId: ProviderNativeId;
  login: string;
  displayName?: string;
  type: 'user' | 'bot' | 'service';
  isRepositoryAdmin?: boolean;
  isOrganizationAdmin?: boolean;
}

export type ChangeTrust =
  | 'same-repo-trusted'
  | 'same-repo-untrusted'
  | 'fork-public'
  | 'fork-private'
  | 'unknown';

export interface ChangeRequest {
  ref: ChangeRequestRef;
  revision: Revision;
  title: string;
  description: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: Actor;
  labels: string[];
  reviewers: Actor[];
  linkedIssues: IssueRef[];
  mergeability: 'mergeable' | 'conflicting' | 'blocked' | 'unknown';
  trust: ChangeTrust;
  capabilities: ChangeRequestCapabilities;
}

export function isForkTrust(trust: ChangeTrust): boolean {
  return trust === 'fork-public' || trust === 'fork-private';
}
