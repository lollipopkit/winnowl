import type { Actor, ChangeRequestRef, IssueRef, ProviderKind, RepositoryRef } from '@reviewbot/domain';

/**
 * Domain events use internal refs (UUIDs); webhook-ingress produces them after resolving a
 * ProviderWebhookEvent. Adapters never produce them.
 */
interface DomainEventBase {
  eventId: string;
  provider: ProviderKind;
  occurredAt: string;
}

export interface ChangeRequestOpened extends DomainEventBase {
  type: 'change-request.opened';
  changeRequest: ChangeRequestRef;
  headSha: string;
  baseSha: string;
  actor: Actor;
  draft: boolean;
}

export interface ChangeRequestUpdated extends DomainEventBase {
  type: 'change-request.updated';
  changeRequest: ChangeRequestRef;
  previousHeadSha?: string;
  headSha: string;
  baseSha: string;
  actor: Actor;
  reason: 'commit-pushed' | 'force-pushed' | 'base-updated' | 'metadata-edited';
}

export interface ChangeRequestReopened extends DomainEventBase {
  type: 'change-request.reopened';
  changeRequest: ChangeRequestRef;
  actor: Actor;
}

export interface ChangeRequestClosed extends DomainEventBase {
  type: 'change-request.closed';
  changeRequest: ChangeRequestRef;
  actor: Actor;
}

export interface ChangeRequestMerged extends DomainEventBase {
  type: 'change-request.merged';
  changeRequest: ChangeRequestRef;
  mergeCommitSha?: string;
  actor: Actor;
}

export interface ChangeRequestReady extends DomainEventBase {
  type: 'change-request.ready';
  changeRequest: ChangeRequestRef;
  actor: Actor;
}

export interface ReviewRequested extends DomainEventBase {
  type: 'review.requested';
  changeRequest: ChangeRequestRef;
  reviewer: Actor;
  actor: Actor;
}

export type CommentTarget =
  | { kind: 'change-request'; ref: ChangeRequestRef }
  | { kind: 'issue'; ref: IssueRef };

export interface CommentCreated extends DomainEventBase {
  type: 'comment.created';
  target: CommentTarget;
  commentNativeId: string;
  body: string;
  actor: Actor;
}

export interface ReviewCommentCreated extends DomainEventBase {
  type: 'review-comment.created';
  changeRequest: ChangeRequestRef;
  commentNativeId: string;
  threadNativeId?: string;
  body: string;
  actor: Actor;
}

export interface ThreadResolved extends DomainEventBase {
  type: 'thread.resolved';
  changeRequest: ChangeRequestRef;
  threadNativeId: string;
  actor: Actor;
}

export interface IssueOpened extends DomainEventBase {
  type: 'issue.opened';
  issue: IssueRef;
  actor: Actor;
}

export interface IssueUpdated extends DomainEventBase {
  type: 'issue.updated';
  issue: IssueRef;
  actor: Actor;
}

export interface LabelChanged extends DomainEventBase {
  type: 'label.changed';
  target: CommentTarget;
  added: string[];
  removed: string[];
  actor: Actor;
}

export interface CheckCompleted extends DomainEventBase {
  type: 'check.completed';
  repository: RepositoryRef;
  headSha: string;
  name: string;
  conclusion: string;
}

export interface PipelineCompleted extends DomainEventBase {
  type: 'pipeline.completed';
  repository: RepositoryRef;
  headSha: string;
  status: string;
}

export interface PushReceived extends DomainEventBase {
  type: 'push.received';
  repository: RepositoryRef;
  ref: string;
  beforeSha: string;
  afterSha: string;
  actor: Actor;
}

export interface InstallationChanged extends DomainEventBase {
  type: 'installation.changed';
  installationNativeId: string;
  action: 'created' | 'deleted' | 'suspended' | 'unsuspended' | 'repositories-changed';
}

export interface RepositoryConfigChanged extends DomainEventBase {
  type: 'repository-config.changed';
  repository: RepositoryRef;
  ref: string;
}

export type DomainEvent =
  | ChangeRequestOpened
  | ChangeRequestUpdated
  | ChangeRequestReopened
  | ChangeRequestClosed
  | ChangeRequestMerged
  | ChangeRequestReady
  | ReviewRequested
  | CommentCreated
  | ReviewCommentCreated
  | ThreadResolved
  | IssueOpened
  | IssueUpdated
  | LabelChanged
  | CheckCompleted
  | PipelineCompleted
  | PushReceived
  | InstallationChanged
  | RepositoryConfigChanged;

export type DomainEventType = DomainEvent['type'];
