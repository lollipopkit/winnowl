import type { Actor, ChangeRequestRef, IssueRef } from '@reviewbot/domain';
import type { ProviderAnchor, RichComment } from './messaging.js';

export interface Commit {
  sha: string;
  message: string;
  author?: Actor;
  authoredAt?: string;
  parents: string[];
}

export interface ChangedFile {
  oldPath?: string;
  newPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'binary';
  additions: number;
  deletions: number;
}

/** Provider diff, used only for validation and truncation detection. */
export interface ProviderDiff {
  raw: string;
  truncated: boolean;
}

export interface ReviewRecord {
  nativeId: string;
  author: Actor;
  state: 'approved' | 'changes-requested' | 'commented' | 'dismissed' | 'pending';
  submittedAt?: string;
}

/** Only when the provider supports reviewBatches. */
export interface ReviewBatchComment {
  anchor: ProviderAnchor;
  body: RichComment;
}

export interface ReviewBatch {
  event: 'comment' | 'approve' | 'request-changes';
  summary?: RichComment;
  comments: ReviewBatchComment[];
}

export interface ReviewReceipt {
  nativeId: string;
  url?: string;
}

export interface CheckInput {
  name: string;
  status: 'queued' | 'in-progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed-out' | 'action-required';
  title?: string;
  summary?: string;
  detailsUrl?: string;
  headSha: string;
}

export interface CheckReceipt {
  nativeId: string;
  url?: string;
}

export interface IssueInput {
  title: string;
  body: RichComment;
  labels?: string[];
  assignees?: string[];
}

export interface IssueContent {
  nativeId: string;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
}

export interface IssueReceipt {
  ref: IssueRef;
  url?: string;
}

export interface BranchRef {
  name: string;
  sha: string;
}

export interface CreateChangeRequestInput {
  title: string;
  body: RichComment;
  /** Already pushed, in the bot's safe namespace (reviewbot/…). */
  sourceBranch: string;
  /** For stacked CRs, the original PR's source branch. */
  targetBranch: string;
  draft?: boolean;
}

export interface ChangeRequestReceipt {
  ref: ChangeRequestRef;
  url?: string;
}
