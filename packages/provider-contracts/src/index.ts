export { ProviderError, UnsupportedCapabilityError } from './errors.js';
export type { CapabilityName, ProviderErrorOptions } from './errors.js';

export {
  idempotencyMarker,
  withIdempotencyMarker,
  hasIdempotencyMarker,
} from './idempotency.js';

export { noCapabilities, capabilities, requireCapability } from './capabilities.js';

export type {
  IdempotencyContext,
  RichComment,
  CommentRef,
  CommentReceipt,
  DiscussionThreadRef,
  DiscussionThreadComment,
  DiscussionThread,
  DiscussionTarget,
  ProviderAnchor,
  TopLevelComment,
} from './messaging.js';

export type {
  Commit,
  ChangedFile,
  ProviderDiff,
  ReviewRecord,
  ReviewBatch,
  ReviewBatchComment,
  ReviewReceipt,
  CheckInput,
  CheckReceipt,
  IssueContent,
  IssueInput,
  IssueReceipt,
  BranchRef,
  CreateChangeRequestInput,
  ChangeRequestReceipt,
} from './change.js';

export type {
  DomainEvent,
  DomainEventType,
  CommentTarget,
  ChangeRequestOpened,
  ChangeRequestUpdated,
  ChangeRequestReopened,
  ChangeRequestClosed,
  ChangeRequestMerged,
  ChangeRequestReady,
  ReviewRequested,
  CommentCreated,
  ReviewCommentCreated,
  ThreadResolved,
  IssueOpened,
  IssueUpdated,
  LabelChanged,
  CheckCompleted,
  PipelineCompleted,
  PushReceived,
  InstallationChanged,
  RepositoryConfigChanged,
} from './events.js';

export { webhookDedupeKey } from './webhook.js';
export { neutralizeMentions, guardMentions } from './mentions.js';
export type {
  RawWebhookDelivery,
  WebhookVerificationResult,
  DedupeKeyOptions,
  ProviderWebhookEvent,
  ProviderWebhookEventType,
  ProviderRepoCoordinates,
  ProviderChangeCoordinates,
  ProviderActorInfo,
  ProviderStackInfo,
} from './webhook.js';

export type {
  SourceControlProvider,
  GitCommitIdentity,
  ProviderIdentityApi,
  RepositoryApi,
  PathCommitAuthor,
  RepositoryPermission,
  ChangeRequestApi,
  DiscussionApi,
  IssueApi,
  CheckApi,
  ReactionApi,
  ReactionContent,
  PipelineApi,
  PipelineRun,
  PipelineRunRef,
  PipelineJob,
  PipelineJobRef,
  PipelineLogs,
  BranchApi,
  CommitApi,
  CommitFileChange,
  WebhookApi,
  ProviderCapabilityApi,
} from './provider.js';
