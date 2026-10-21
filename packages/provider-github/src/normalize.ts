import type {
  ProviderChangeCoordinates,
  ProviderWebhookEvent,
  RawWebhookDelivery,
} from '@reviewbot/provider-contracts';
import {
  toActor,
  toRepoCoordinates,
  type GhInstallationEvent,
  type GhIssueCommentEvent,
  type GhPull,
  type GhPullRequestEvent,
  type GhPullRequestReviewCommentEvent,
  type GhPullRequestReviewEvent,
  type GhIssuesEvent,
  type GhPushEvent,
  type GhRepo,
  type GhWorkflowRunEvent,
} from './payloads.js';

function toChange(repo: GhRepo, pull: GhPull, hostId: string): ProviderChangeCoordinates {
  return {
    repo: toRepoCoordinates(repo, hostId),
    number: pull.number,
    nativeId: String(pull.id),
    kind: 'pull-request',
  };
}

/** undefined when the payload has no repo info; a null head.repo means the fork was deleted. */
function sourceIsFork(pull: GhPull): boolean | undefined {
  if (pull.head.repo === undefined || !pull.base.repo) return undefined;
  return pull.head.repo === null || pull.head.repo.id !== pull.base.repo.id;
}

function normalizePullRequest(event: GhPullRequestEvent, hostId: string): ProviderWebhookEvent {
  const change = toChange(event.repository, event.pull_request, hostId);
  const actor = toActor(event.sender);
  const pull = event.pull_request;
  const occurredAt = pull.updated_at;
  const reviewers = (pull.requested_reviewers ?? []).map(toActor);
  const labels = pull.labels?.map((l) => l.name);
  const isFork = sourceIsFork(pull);
  const title = typeof pull.title === 'string' ? pull.title : undefined;
  // `stack.base` (the root PR's base) is what base_branches is checked against; otherwise every
  // PR above the root would be filtered out.
  const stack = pull.stack
    ? {
        ...(pull.stack.id !== undefined ? { id: String(pull.stack.id) } : {}),
        ...(pull.stack.size !== undefined ? { size: pull.stack.size } : {}),
        ...(pull.stack.position !== undefined ? { position: pull.stack.position } : {}),
        ...(pull.stack.base?.ref ? { baseRef: pull.stack.base.ref } : {}),
        ...(pull.stack.base?.sha ? { baseSha: pull.stack.base.sha } : {}),
      }
    : undefined;

  switch (event.action) {
    case 'opened':
      return {
        type: 'change-request.opened',
        change,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        sourceBranch: pull.head.ref,
        targetBranch: pull.base.ref,
        ...(isFork !== undefined ? { sourceIsFork: isFork } : {}),
        ...(title !== undefined ? { title } : {}),
        draft: pull.draft ?? false,
        actor,
        ...(occurredAt ? { occurredAt } : {}),
        reviewers,
        ...(labels !== undefined ? { labels } : {}),
        ...(stack ? { stack } : {}),
      };
    case 'reopened':
      return {
        type: 'change-request.reopened',
        change,
        actor,
        ...(occurredAt ? { occurredAt } : {}),
      };
    case 'ready_for_review':
      return { type: 'change-request.ready', change, actor, ...(occurredAt ? { occurredAt } : {}) };
    // Only refreshes the draft flag; same head, no review.
    case 'converted_to_draft':
      return {
        type: 'change-request.updated',
        change,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        sourceBranch: pull.head.ref,
        targetBranch: pull.base.ref,
        ...(isFork !== undefined ? { sourceIsFork: isFork } : {}),
        ...(title !== undefined ? { title } : {}),
        reason: 'metadata-edited',
        draft: true,
        actor,
        ...(occurredAt ? { occurredAt } : {}),
        ...(pull.user ? { author: toActor(pull.user) } : {}),
      };
    case 'closed':
      return pull.merged
        ? {
            type: 'change-request.merged',
            change,
            ...(pull.merge_commit_sha ? { mergeCommitSha: pull.merge_commit_sha } : {}),
            actor,
            ...(occurredAt ? { occurredAt } : {}),
          }
        : { type: 'change-request.closed', change, actor, ...(occurredAt ? { occurredAt } : {}) };
    case 'synchronize':
      return {
        type: 'change-request.updated',
        change,
        headSha: event.after ?? pull.head.sha,
        ...(event.before ? { previousHeadSha: event.before } : {}),
        baseSha: pull.base.sha,
        sourceBranch: pull.head.ref,
        targetBranch: pull.base.ref,
        ...(isFork !== undefined ? { sourceIsFork: isFork } : {}),
        ...(title !== undefined ? { title } : {}),
        reason: 'commit-pushed',
        ...(pull.draft !== undefined ? { draft: pull.draft } : {}),
        actor,
        ...(occurredAt ? { occurredAt } : {}),
        ...(pull.user ? { author: toActor(pull.user) } : {}),
        reviewers,
        ...(labels !== undefined ? { labels } : {}),
        ...(stack ? { stack } : {}),
      };
    case 'edited':
      return {
        type: 'change-request.updated',
        change,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        sourceBranch: pull.head.ref,
        targetBranch: pull.base.ref,
        ...(isFork !== undefined ? { sourceIsFork: isFork } : {}),
        ...(title !== undefined ? { title } : {}),
        reason: event.changes?.base ? 'base-updated' : 'metadata-edited',
        ...(pull.draft !== undefined ? { draft: pull.draft } : {}),
        actor,
        ...(occurredAt ? { occurredAt } : {}),
        ...(pull.user ? { author: toActor(pull.user) } : {}),
        reviewers,
        ...(labels !== undefined ? { labels } : {}),
        ...(stack ? { stack } : {}),
      };
    // Always send the full list, even empty, so removing the last reviewer is seen.
    case 'review_requested':
    case 'review_request_removed':
      return {
        type: 'change-request.updated',
        change,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        sourceBranch: pull.head.ref,
        targetBranch: pull.base.ref,
        ...(isFork !== undefined ? { sourceIsFork: isFork } : {}),
        ...(title !== undefined ? { title } : {}),
        reason: 'metadata-edited',
        actor,
        ...(occurredAt ? { occurredAt } : {}),
        ...(pull.user ? { author: toActor(pull.user) } : {}),
        reviewers,
        ...(labels !== undefined ? { labels } : {}),
        ...(stack ? { stack } : {}),
      };
    // Always send the full list, even empty, so removing the last label is seen.
    case 'labeled':
    case 'unlabeled':
      return {
        type: 'change-request.updated',
        change,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        sourceBranch: pull.head.ref,
        targetBranch: pull.base.ref,
        ...(isFork !== undefined ? { sourceIsFork: isFork } : {}),
        ...(title !== undefined ? { title } : {}),
        reason: 'metadata-edited',
        actor,
        ...(occurredAt ? { occurredAt } : {}),
        ...(pull.user ? { author: toActor(pull.user) } : {}),
        ...(pull.draft !== undefined ? { draft: pull.draft } : {}),
        labels: labels ?? [],
      };
    default:
      return { type: 'ignored', reason: `pull_request:${event.action}` };
  }
}

function normalizeIssueComment(event: GhIssueCommentEvent, hostId: string): ProviderWebhookEvent {
  const repo = toRepoCoordinates(event.repository, hostId);
  const isPull = event.issue.pull_request !== undefined && event.issue.pull_request !== null;
  // Only PR comment edits that changed the body. The editor is `sender`, not the (bot) comment author.
  if (event.action === 'edited') {
    if (!isPull || event.changes?.body?.from === undefined) {
      return { type: 'ignored', reason: 'issue_comment:edited' };
    }
    return {
      type: 'comment.edited',
      change: { repo, number: event.issue.number, nativeId: String(event.issue.id), kind: 'pull-request' },
      commentNativeId: String(event.comment.id),
      body: event.comment.body,
      previousBody: event.changes.body.from,
      author: toActor(event.comment.user),
      actor: toActor(event.sender),
    };
  }
  if (event.action !== 'created') {
    return { type: 'ignored', reason: `issue_comment:${event.action}` };
  }
  const actor = toActor(event.comment.user);
  return {
    type: 'comment.created',
    target: isPull
      ? {
          kind: 'change-request',
          change: {
            repo,
            number: event.issue.number,
            nativeId: String(event.issue.id),
            kind: 'pull-request',
          },
        }
      : { kind: 'issue', repo, number: event.issue.number, nativeId: String(event.issue.id) },
    commentNativeId: String(event.comment.id),
    body: event.comment.body,
    actor,
  };
}

/** Review body edits that changed the body; the editor is `sender`, the author `review.user`. */
function normalizePullRequestReview(event: GhPullRequestReviewEvent, hostId: string): ProviderWebhookEvent {
  if (event.action !== 'edited' || event.changes?.body?.from === undefined || event.review.body === null) {
    return { type: 'ignored', reason: `pull_request_review:${event.action}` };
  }
  return {
    type: 'comment.edited',
    change: {
      repo: toRepoCoordinates(event.repository, hostId),
      number: event.pull_request.number,
      nativeId: String(event.pull_request.id),
      kind: 'pull-request',
    },
    commentNativeId: String(event.review.id),
    body: event.review.body,
    previousBody: event.changes.body.from,
    author: toActor(event.review.user),
    actor: toActor(event.sender),
  };
}

function normalizePullRequestReviewComment(
  event: GhPullRequestReviewCommentEvent,
  hostId: string,
): ProviderWebhookEvent {
  // Inline comments normalise like top-level ones, so they reuse the conversation flow.
  if (event.action !== 'created') {
    return { type: 'ignored', reason: `pull_request_review_comment:${event.action}` };
  }
  const repo = toRepoCoordinates(event.repository, hostId);
  return {
    type: 'comment.created',
    target: {
      kind: 'change-request',
      change: {
        repo,
        number: event.pull_request.number,
        nativeId: String(event.pull_request.id),
        kind: 'pull-request',
      },
    },
    commentNativeId: String(event.comment.id),
    body: event.comment.body,
    actor: toActor(event.comment.user),
    // The thread id must be `in_reply_to_id` (the first comment): commands are replies to the bot's
    // finding comment, and the reply's own id maps to no finding.
    reviewThread: {
      ...(event.comment.path ? { path: event.comment.path } : {}),
      threadNativeId: String(event.comment.in_reply_to_id ?? event.comment.id),
    },
  };
}

function normalizePush(event: GhPushEvent, hostId: string): ProviderWebhookEvent {
  return {
    type: 'push.received',
    repo: toRepoCoordinates(event.repository, hostId),
    ref: event.ref,
    beforeSha: event.before,
    afterSha: event.after,
    actor: toActor(event.sender),
  };
}

function normalizeWorkflowRun(event: GhWorkflowRunEvent, hostId: string): ProviderWebhookEvent {
  if (event.action !== 'completed') {
    return { type: 'ignored', reason: `workflow_run:${event.action}` };
  }
  return {
    type: 'pipeline.completed',
    repo: toRepoCoordinates(event.repository, hostId),
    headSha: event.workflow_run.head_sha,
    status: event.workflow_run.status,
    conclusion: event.workflow_run.conclusion ?? 'unknown',
    actor: toActor(event.sender),
  };
}

function normalizeIssues(event: GhIssuesEvent, hostId: string): ProviderWebhookEvent {
  // PRs also show up as issues in some events; only real issues are handled.
  if (event.action !== 'opened' || event.issue.pull_request) {
    return { type: 'ignored', reason: `issues:${event.action}` };
  }
  return {
    type: 'issue.opened',
    repo: toRepoCoordinates(event.repository, hostId),
    number: event.issue.number,
    nativeId: String(event.issue.id),
    title: event.issue.title,
    body: event.issue.body ?? '',
    actor: toActor(event.sender),
  };
}

type InstallationAction =
  'created' | 'deleted' | 'suspended' | 'unsuspended' | 'repositories-changed';

function installationAction(action: string): InstallationAction {
  switch (action) {
    case 'created':
      return 'created';
    case 'deleted':
      return 'deleted';
    case 'suspend':
      return 'suspended';
    case 'unsuspend':
      return 'unsuspended';
    default:
      return 'repositories-changed';
  }
}

/** Form-encoded deliveries carry JSON in `payload`; signatures are verified on the raw body before this. */
function jsonBodyOf(raw: RawWebhookDelivery): string | null {
  const ct = (raw.headers['content-type'] ?? raw.headers['Content-Type']) as
    string | string[] | undefined;
  const contentType = (Array.isArray(ct) ? ct[0] : ct) ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(raw.body).get('payload');
  }
  return raw.body;
}

/** Unhandled events return `{ type: 'ignored' }` instead of being dropped silently. */
export function normalizeGithubWebhook(raw: RawWebhookDelivery): ProviderWebhookEvent[] {
  const hostId = raw.providerHostId;
  const jsonBody = jsonBodyOf(raw);
  if (jsonBody === null) return [{ type: 'ignored', reason: 'invalid_json' }];
  let payload: unknown;
  try {
    payload = JSON.parse(jsonBody);
  } catch {
    return [{ type: 'ignored', reason: 'invalid_json' }];
  }

  switch (raw.eventType) {
    case 'pull_request':
      return [normalizePullRequest(payload as GhPullRequestEvent, hostId)];
    case 'issue_comment':
      return [normalizeIssueComment(payload as GhIssueCommentEvent, hostId)];
    case 'pull_request_review':
      return [normalizePullRequestReview(payload as GhPullRequestReviewEvent, hostId)];
    case 'pull_request_review_comment':
      return [
        normalizePullRequestReviewComment(payload as GhPullRequestReviewCommentEvent, hostId),
      ];
    case 'push':
      return [normalizePush(payload as GhPushEvent, hostId)];
    case 'workflow_run':
      return [normalizeWorkflowRun(payload as GhWorkflowRunEvent, hostId)];
    case 'issues':
      return [normalizeIssues(payload as GhIssuesEvent, hostId)];
    case 'installation':
    case 'installation_repositories': {
      const event = payload as GhInstallationEvent;
      return [
        {
          type: 'installation.changed',
          installationNativeId: String(event.installation.id),
          action: installationAction(event.action),
        },
      ];
    }
    case 'ping':
      return [{ type: 'ignored', reason: 'ping' }];
    default:
      return [{ type: 'ignored', reason: `unhandled_event:${raw.eventType}` }];
  }
}
