import type { ProviderActorInfo, ProviderRepoCoordinates } from '@reviewbot/provider-contracts';

/** Only the webhook payload fields we read; not the full schema. */

export interface GhUser {
  id: number;
  login: string;
  type?: string;
}

export interface GhRepo {
  id: number;
  name: string;
  default_branch: string;
  clone_url: string;
  owner: { login: string };
}

export interface GhPull {
  id: number;
  number: number;
  title?: string;
  draft?: boolean;
  merged?: boolean;
  merge_commit_sha?: string | null;
  /** `repo` is null when the fork was deleted. */
  head: { sha: string; ref: string; repo?: { id: number } | null };
  base: { sha: string; ref: string; repo?: { id: number } | null };
  /** Users only; team reviewers are in requested_teams. */
  requested_reviewers?: GhUser[];
  labels?: { name: string }[];
  /** Present on every pull_request payload, so metadata events can carry the author when `opened` arrives late. */
  user?: GhUser;
  updated_at?: string;
  /**
   * Native stacked PRs (preview); absent for non-members. `base` is the whole stack's final target
   * (the root PR's base), not this PR's base.
   */
  stack?: {
    id?: number;
    size?: number;
    position?: number;
    base?: { ref?: string; sha?: string };
  };
}

export interface GhPullRequestEvent {
  action: string;
  repository: GhRepo;
  pull_request: GhPull;
  sender: GhUser;
  before?: string;
  after?: string;
  changes?: { base?: unknown };
}

export interface GhIssue {
  number: number;
  id: number;
  pull_request?: unknown;
}

export interface GhIssueCommentEvent {
  action: string;
  repository: GhRepo;
  issue: GhIssue;
  comment: { id: number; body: string; user: GhUser };
  /** `edited` only: the previous body. */
  changes?: { body?: { from: string } };
  sender: GhUser;
}

/** pull_request_review: only `edited` is used (the fix checkbox in the review body). */
export interface GhPullRequestReviewEvent {
  action: string;
  repository: GhRepo;
  pull_request: GhPull;
  review: { id: number; body: string | null; user: GhUser };
  changes?: { body?: { from: string } };
  sender: GhUser;
}

export interface GhPullRequestReviewCommentEvent {
  action: string;
  repository: GhRepo;
  pull_request: GhPull;
  /** Points at the thread's first comment; absent for a new thread. */
  comment: {
    id: number;
    body: string;
    user: GhUser;
    path?: string;
    line?: number;
    in_reply_to_id?: number;
  };
  sender: GhUser;
}

export interface GhPushEvent {
  repository: GhRepo;
  ref: string;
  before: string;
  after: string;
  sender: GhUser;
}

export interface GhInstallationEvent {
  action: string;
  installation: { id: number };
}

export interface GhWorkflowRunEvent {
  action: string;
  workflow_run: { id: number; head_sha: string; status: string; conclusion: string | null };
  repository: GhRepo;
  sender: GhUser;
}

export interface GhIssuesEvent {
  action: string;
  issue: { id: number; number: number; title: string; body: string | null; pull_request?: unknown };
  repository: GhRepo;
  sender: GhUser;
}

export function toRepoCoordinates(repo: GhRepo, hostId: string): ProviderRepoCoordinates {
  return {
    hostId,
    repoNativeId: String(repo.id),
    namespace: repo.owner.login,
    name: repo.name,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch,
  };
}

export function toActor(user: GhUser): ProviderActorInfo {
  return {
    providerUserId: String(user.id),
    login: user.login,
    type: user.type === 'Bot' ? 'bot' : 'user',
  };
}
