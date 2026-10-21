import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ProviderChangeCoordinates,
  ProviderRepoCoordinates,
  ProviderWebhookEvent,
  RawWebhookDelivery,
  WebhookVerificationResult,
} from '@reviewbot/provider-contracts';

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** `X-Forgejo-Signature` or `X-Gitea-Signature`: hex HMAC-SHA256 of the body. */
export function verifyForgejoWebhook(
  raw: RawWebhookDelivery,
  secret: string,
): WebhookVerificationResult {
  const provided =
    headerValue(raw.headers, 'x-forgejo-signature') ??
    headerValue(raw.headers, 'x-gitea-signature');
  if (!provided) return { valid: false, reason: 'missing_signature' };
  const expected = createHmac('sha256', secret).update(raw.body, 'utf8').digest('hex');
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

export function parseForgejoDelivery(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  providerHostId: string,
  receivedAt: string,
): RawWebhookDelivery {
  const eventType =
    headerValue(headers, 'x-forgejo-event') ?? headerValue(headers, 'x-gitea-event') ?? 'unknown';
  const deliveryId =
    headerValue(headers, 'x-forgejo-delivery') ?? headerValue(headers, 'x-gitea-delivery');
  return {
    provider: 'forgejo',
    providerHostId,
    ...(deliveryId !== undefined ? { deliveryId } : {}),
    eventType,
    headers,
    body,
    receivedAt,
  };
}

interface FjUser {
  id: number;
  login?: string;
  username?: string;
}
interface FjRepo {
  id: number;
  name: string;
  owner: FjUser;
  clone_url?: string;
  default_branch?: string;
}
interface FjPull {
  id: number;
  number: number;
  title?: string;
  draft?: boolean;
  merged?: boolean;
  merge_commit_sha?: string;
  /** `repo` is null when the source fork was deleted. */
  head: { sha: string; ref: string; repo?: { id: number } | null };
  base: { sha: string; ref: string; repo?: { id: number } | null };
  labels?: { name: string }[];
  updated_at?: string;
  user?: { id?: number; login?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFjUser(value: unknown): value is FjUser {
  return isRecord(value) && typeof value.id === 'number';
}

function isFjRepo(value: unknown): value is FjRepo {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.name === 'string' &&
    isFjUser(value.owner)
  );
}

function isFjPull(value: unknown): value is FjPull {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.number === 'number' &&
    isRecord(value.head) &&
    typeof value.head.sha === 'string' &&
    typeof value.head.ref === 'string' &&
    isRecord(value.base) &&
    typeof value.base.sha === 'string' &&
    typeof value.base.ref === 'string' &&
    (value.labels === undefined ||
      (Array.isArray(value.labels) &&
        value.labels.every((label) => isRecord(label) && typeof label.name === 'string')))
  );
}

function login(user: FjUser): string {
  return user.login ?? user.username ?? '';
}

function toRepo(repo: FjRepo, hostId: string): ProviderRepoCoordinates {
  return {
    hostId,
    repoNativeId: String(repo.id),
    namespace: login(repo.owner),
    name: repo.name,
    ...(repo.clone_url ? { cloneUrl: repo.clone_url } : {}),
    ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
  };
}

function toChange(repo: FjRepo, pull: FjPull, hostId: string): ProviderChangeCoordinates {
  return {
    repo: toRepo(repo, hostId),
    number: pull.number,
    nativeId: String(pull.id),
    kind: 'pull-request',
  };
}

function toActor(user: FjUser): { providerUserId: string; login: string; type: 'user' } {
  return { providerUserId: String(user.id), login: login(user), type: 'user' };
}

export function normalizeForgejoWebhook(raw: RawWebhookDelivery): ProviderWebhookEvent[] {
  const hostId = raw.providerHostId;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.body);
  } catch {
    return [{ type: 'ignored', reason: 'invalid_json' }];
  }
  if (!isRecord(parsed)) return [{ type: 'ignored', reason: 'invalid_payload' }];
  const payload = parsed as {
    action?: string;
    repository?: FjRepo;
    pull_request?: FjPull;
    issue?: { id: number; number: number; pull_request?: unknown };
    comment?: { id: number; body: string; user: FjUser };
    /** `edited` only: body before the edit. */
    changes?: { body?: { from?: string } };
    sender?: FjUser;
    ref?: string;
    before?: string;
    after?: string;
    pusher?: FjUser;
  };

  switch (raw.eventType) {
    case 'pull_request': {
      if (!isFjRepo(payload.repository) || !isFjPull(payload.pull_request))
        return [{ type: 'ignored', reason: 'incomplete_pr' }];
      const change = toChange(payload.repository, payload.pull_request, hostId);
      const actor = isFjUser(payload.sender)
        ? toActor(payload.sender)
        : { providerUserId: '0', login: 'unknown', type: 'user' as const };
      const pull = payload.pull_request;
      // PR author, not the sender (who labeled or pushed).
      const author = pull.user ? toActor({ id: pull.user.id ?? 0, login: pull.user.login ?? '' } as FjUser) : undefined;
      const occurredAt = pull.updated_at;
      const sourceIsFork =
        pull.head.repo === undefined || !pull.base.repo
          ? undefined
          : pull.head.repo === null || pull.head.repo.id !== pull.base.repo.id;
      const title = typeof pull.title === 'string' ? pull.title : undefined;
      switch (payload.action) {
        case 'opened':
          return [
            {
              type: 'change-request.opened',
              change,
              headSha: pull.head.sha,
              baseSha: pull.base.sha,
              sourceBranch: pull.head.ref,
              targetBranch: pull.base.ref,
              ...(sourceIsFork !== undefined ? { sourceIsFork } : {}),
              ...(title !== undefined ? { title } : {}),
              draft: pull.draft ?? false,
              actor,
              ...(occurredAt ? { occurredAt } : {}),
              ...(pull.labels !== undefined ? { labels: pull.labels.map((l) => l.name) } : {}),
            },
          ];
        case 'reopened':
          return [
            {
              type: 'change-request.reopened',
              change,
              actor,
              ...(occurredAt ? { occurredAt } : {}),
            },
          ];
        case 'synchronized':
          return [
            {
              type: 'change-request.updated',
              change,
              headSha: pull.head.sha,
              ...(payload.before ? { previousHeadSha: payload.before } : {}),
              baseSha: pull.base.sha,
              sourceBranch: pull.head.ref,
              targetBranch: pull.base.ref,
              ...(sourceIsFork !== undefined ? { sourceIsFork } : {}),
              ...(title !== undefined ? { title } : {}),
              reason: 'commit-pushed',
              ...(pull.draft !== undefined ? { draft: pull.draft } : {}),
              actor,
              ...(author ? { author } : {}),
              ...(occurredAt ? { occurredAt } : {}),
              ...(pull.labels !== undefined ? { labels: pull.labels.map((l) => l.name) } : {}),
            },
          ];
        case 'edited':
        case 'labeled':
        case 'unlabeled':
        case 'label_updated':
          return [
            {
              type: 'change-request.updated',
              change,
              headSha: pull.head.sha,
              baseSha: pull.base.sha,
              sourceBranch: pull.head.ref,
              targetBranch: pull.base.ref,
              ...(sourceIsFork !== undefined ? { sourceIsFork } : {}),
              ...(title !== undefined ? { title } : {}),
              reason: 'metadata-edited',
              ...(pull.draft !== undefined ? { draft: pull.draft } : {}),
              actor,
              ...(author ? { author } : {}),
              ...(occurredAt ? { occurredAt } : {}),
              ...(pull.labels !== undefined ? { labels: pull.labels.map((l) => l.name) } : {}),
            },
          ];
        case 'closed':
          return pull.merged
            ? [
                {
                  type: 'change-request.merged',
                  change,
                  ...(pull.merge_commit_sha ? { mergeCommitSha: pull.merge_commit_sha } : {}),
                  actor,
                  ...(occurredAt ? { occurredAt } : {}),
                },
              ]
            : [
                {
                  type: 'change-request.closed',
                  change,
                  actor,
                  ...(occurredAt ? { occurredAt } : {}),
                },
              ];
        default:
          return [{ type: 'ignored', reason: `pull_request:${payload.action ?? 'unknown'}` }];
      }
    }
    case 'issue_comment': {
      // Edited comment (e.g. a status-comment checkbox): editor is sender, author is comment.user.
      if (
        payload.action === 'edited' &&
        isFjRepo(payload.repository) &&
        isRecord(payload.issue) &&
        typeof payload.issue.id === 'number' &&
        typeof payload.issue.number === 'number' &&
        payload.issue.pull_request !== undefined &&
        payload.issue.pull_request !== null &&
        isRecord(payload.comment) &&
        typeof payload.comment.id === 'number' &&
        typeof payload.comment.body === 'string' &&
        isFjUser(payload.comment.user) &&
        isFjUser(payload.sender)
      ) {
        const from = payload.changes?.body?.from;
        return [
          {
            type: 'comment.edited',
            change: {
              repo: toRepo(payload.repository, hostId),
              number: payload.issue.number,
              nativeId: String(payload.issue.id),
              kind: 'pull-request',
            },
            commentNativeId: String(payload.comment.id),
            body: payload.comment.body,
            ...(typeof from === 'string' ? { previousBody: from } : {}),
            author: toActor(payload.comment.user),
            actor: toActor(payload.sender),
          },
        ];
      }
      if (
        payload.action !== 'created' ||
        !isFjRepo(payload.repository) ||
        !isRecord(payload.issue) ||
        typeof payload.issue.id !== 'number' ||
        typeof payload.issue.number !== 'number' ||
        !isRecord(payload.comment) ||
        typeof payload.comment.id !== 'number' ||
        typeof payload.comment.body !== 'string' ||
        !isFjUser(payload.comment.user)
      ) {
        return [{ type: 'ignored', reason: `issue_comment:${payload.action ?? 'unknown'}` }];
      }
      const repo = toRepo(payload.repository, hostId);
      const isPull =
        payload.issue.pull_request !== undefined && payload.issue.pull_request !== null;
      return [
        {
          type: 'comment.created',
          target: isPull
            ? {
                kind: 'change-request',
                change: {
                  repo,
                  number: payload.issue.number,
                  nativeId: String(payload.issue.id),
                  kind: 'pull-request',
                },
              }
            : {
                kind: 'issue',
                repo,
                number: payload.issue.number,
                nativeId: String(payload.issue.id),
              },
          commentNativeId: String(payload.comment.id),
          body: payload.comment.body,
          actor: toActor(payload.comment.user),
        },
      ];
    }
    case 'push': {
      if (!isFjRepo(payload.repository)) return [{ type: 'ignored', reason: 'incomplete_push' }];
      const actor = isFjUser(payload.sender)
        ? payload.sender
        : isFjUser(payload.pusher)
          ? payload.pusher
          : undefined;
      return [
        {
          type: 'push.received',
          repo: toRepo(payload.repository, hostId),
          ref: payload.ref ?? '',
          beforeSha: payload.before ?? '',
          afterSha: payload.after ?? '',
          actor: actor ? toActor(actor) : { providerUserId: '0', login: 'unknown', type: 'user' },
        },
      ];
    }
    default:
      return [{ type: 'ignored', reason: `unhandled_event:${raw.eventType}` }];
  }
}
