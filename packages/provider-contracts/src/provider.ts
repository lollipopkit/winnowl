import type {
  Actor,
  ChangeRequest,
  ChangeRequestCapabilities,
  ChangeRequestRef,
  IssueRef,
  ProviderKind,
  RepositoryRef,
  Revision,
} from '@reviewbot/domain';
import type {
  CommentReceipt,
  CommentRef,
  DiscussionTarget,
  DiscussionThread,
  DiscussionThreadRef,
  IdempotencyContext,
  ProviderAnchor,
  RichComment,
  TopLevelComment,
} from './messaging.js';
import type {
  BranchRef,
  ChangedFile,
  ChangeRequestReceipt,
  CheckInput,
  CheckReceipt,
  Commit,
  CreateChangeRequestInput,
  IssueContent,
  IssueInput,
  IssueReceipt,
  ProviderDiff,
  ReviewBatch,
  ReviewReceipt,
  ReviewRecord,
} from './change.js';
import type {
  ProviderWebhookEvent,
  RawWebhookDelivery,
  WebhookVerificationResult,
} from './webhook.js';

/** Git `user.name` / `user.email` used for the bot's own commits. */
export interface GitCommitIdentity {
  name: string;
  email: string;
}

export interface ProviderIdentityApi {
  botActor(): Promise<Actor>;
  /**
   * Forges link commits to accounts by email, so the identity must come from the forge rather than
   * be synthesised. null when unavailable; the caller falls back.
   */
  commitIdentity?(): Promise<GitCommitIdentity | null>;
}

/**
 * Normalised repo permission using GitHub's levels; GitLab access levels and Forgejo permissions
 * map to the nearest one. Non-members are `none`.
 */
export type RepositoryPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

export interface RepositoryApi {
  get(ref: RepositoryRef): Promise<RepositoryRef>;
  listForInstallation(installationId: string): Promise<RepositoryRef[]>;
  /** Reads one file without a clone; null when missing. gitRef defaults to the default branch. */
  getFileContent?(ref: RepositoryRef, path: string, gitRef?: string): Promise<string | null>;
  /**
   * Non-members resolve to `none`; other errors (e.g. missing credential scope) throw so they stay
   * distinguishable. GitHub/Forgejo look up by login, GitLab by numeric user id.
   */
  getActorPermission?(ref: RepositoryRef, actor: { login: string; providerUserId?: string }): Promise<RepositoryPermission>;
  /**
   * Recent commit authors of a path, newest first, at most `limit`; only authors mapped to a forge
   * account. Not implemented for GitLab: its commits API exposes only emails.
   */
  listPathCommitAuthors?(ref: RepositoryRef, path: string, opts: { gitRef: string; limit: number }): Promise<PathCommitAuthor[]>;
}

export interface PathCommitAuthor {
  actor: Actor;
  /** ISO 8601. */
  committedAt: string;
}

export interface ChangeRequestApi {
  get(ref: ChangeRequestRef): Promise<ChangeRequest>;
  getRevision(ref: ChangeRequestRef): Promise<Revision>;
  listCommits(ref: ChangeRequestRef): Promise<Commit[]>;
  listChangedFiles(ref: ChangeRequestRef): Promise<ChangedFile[]>;
  getProviderDiff(ref: ChangeRequestRef): Promise<ProviderDiff>;
  listReviews(ref: ChangeRequestRef): Promise<ReviewRecord[]>;
  getDescription?(ref: ChangeRequestRef): Promise<string>;
  /** Overwrites the body; callers must keep user text and replace only the winnowl marker section. */
  updateDescription?(ref: ChangeRequestRef, body: string): Promise<void>;
  /** Adds reviewers without removing existing ones. */
  requestReviewers?(ref: ChangeRequestRef, reviewers: Actor[]): Promise<void>;
  /** The source branch must be in the bot's safe namespace. */
  create(
    repo: RepositoryRef,
    input: CreateChangeRequestInput,
    idempotency: IdempotencyContext,
  ): Promise<ChangeRequestReceipt>;
}

export interface DiscussionApi {
  listThreads(target: DiscussionTarget): Promise<DiscussionThread[]>;
  /** Used for comment upserts; without it every post creates a new comment (not idempotent). */
  listTopLevelComments?(target: DiscussionTarget): Promise<TopLevelComment[]>;
  createTopLevelComment(
    target: DiscussionTarget,
    body: RichComment,
    idempotency: IdempotencyContext,
  ): Promise<CommentReceipt>;
  createInlineComment(
    ref: ChangeRequestRef,
    anchor: ProviderAnchor,
    body: RichComment,
    idempotency: IdempotencyContext,
  ): Promise<CommentReceipt>;
  createReviewBatch?(
    ref: ChangeRequestRef,
    review: ReviewBatch,
    idempotency: IdempotencyContext,
  ): Promise<ReviewReceipt>;
  reply(
    thread: DiscussionThreadRef,
    body: RichComment,
    idempotency: IdempotencyContext,
  ): Promise<CommentReceipt>;
  editComment(comment: CommentRef, body: RichComment): Promise<void>;
  resolve?(thread: DiscussionThreadRef): Promise<void>;
  unresolve?(thread: DiscussionThreadRef): Promise<void>;
}

export interface IssueApi {
  get(repo: RepositoryRef, number: number): Promise<IssueContent>;
  create(
    repo: RepositoryRef,
    input: IssueInput,
    idempotency: IdempotencyContext,
  ): Promise<IssueReceipt>;
  comment(
    ref: IssueRef,
    body: RichComment,
    idempotency: IdempotencyContext,
  ): Promise<CommentReceipt>;
}

export interface CheckApi {
  createOrUpdate(
    repo: RepositoryRef,
    input: CheckInput,
    idempotency: IdempotencyContext,
  ): Promise<CheckReceipt>;
}

/** GitHub's reaction set. */
export type ReactionContent = 'eyes' | '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket';

/** Reactions as immediate acknowledgement; adding an existing reaction must not fail. */
export interface ReactionApi {
  addToChangeRequest(ref: ChangeRequestRef, content: ReactionContent): Promise<void>;
  addToIssue(ref: IssueRef, content: ReactionContent): Promise<void>;
}

export interface PipelineRunRef {
  nativeId: string;
  /** Internal repo id, set by listRuns so getJobs can resolve owner/repo. */
  repositoryId?: string;
}
export interface PipelineRun {
  ref: PipelineRunRef;
  status: string;
  headSha: string;
  /** Only set on completed runs. */
  conclusion?: string;
}
export interface PipelineJobRef {
  nativeId: string;
  /** Internal repo id, set by getJobs so getLogs can resolve owner/repo. */
  repositoryId?: string;
}
export interface PipelineJob {
  ref: PipelineJobRef;
  name: string;
  status: string;
  conclusion?: string;
}
export interface PipelineLogs {
  text: string;
  truncated: boolean;
}

export interface PipelineApi {
  listRuns(ref: ChangeRequestRef): Promise<PipelineRun[]>;
  getJobs(run: PipelineRunRef): Promise<PipelineJob[]>;
  getLogs(job: PipelineJobRef): Promise<PipelineLogs>;
  /** Runs a finished run again with its original event (its failed jobs only, when some failed); no-op while it runs. */
  rerun?(run: PipelineRunRef): Promise<void>;
}

export interface BranchApi {
  get(repo: RepositoryRef, name: string): Promise<BranchRef | null>;
  create(repo: RepositoryRef, input: BranchRef): Promise<BranchRef>;
  delete?(repo: RepositoryRef, name: string): Promise<void>;
}

/** One file of a commit built through the API (`CommitApi`). Content is base64 (binary-safe). */
export type CommitFileChange =
  | { path: string; mode: '100644' | '100755' | '120000'; contentBase64: string }
  | { path: string; deleted: true };

/** Commits without a clone, so write credentials never leave the control plane. */
export interface CommitApi {
  /**
   * One commit on `baseSha` with `changes`, then points `branch` at it: created when missing,
   * otherwise moved even when that is not a fast-forward. Only for the bot's own branches.
   * Returns the commit sha.
   */
  commitChanges(
    repo: RepositoryRef,
    input: {
      baseSha: string;
      branch: string;
      message: string;
      author: { name: string; email: string };
      changes: CommitFileChange[];
    },
  ): Promise<string>;
}

export interface WebhookApi {
  verify(raw: RawWebhookDelivery, secret: string): WebhookVerificationResult;
  normalize(raw: RawWebhookDelivery): ProviderWebhookEvent[];
}

export interface ProviderCapabilityApi {
  forChangeRequest(ref: ChangeRequestRef): Promise<ChangeRequestCapabilities>;
}

/** Source-control provider abstraction; review core depends only on this, never on provider SDKs. */
export interface SourceControlProvider {
  readonly kind: ProviderKind;
  identity: ProviderIdentityApi;
  repositories: RepositoryApi;
  changes: ChangeRequestApi;
  discussions: DiscussionApi;
  issues: IssueApi;
  checks: CheckApi;
  reactions?: ReactionApi;
  pipelines: PipelineApi;
  branches: BranchApi;
  /** API commits (no clone); optional — a provider without it cannot deliver fixes. */
  commits?: CommitApi;
  webhooks: WebhookApi;
  capabilities: ProviderCapabilityApi;
}
