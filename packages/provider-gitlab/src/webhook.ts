import { timingSafeEqual } from 'node:crypto';
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

/** `X-Gitlab-Token` carries the plain secret (not an HMAC); compared in constant time. */
export function verifyGitlabWebhook(
  raw: RawWebhookDelivery,
  secret: string,
): WebhookVerificationResult {
  const provided = headerValue(raw.headers, 'x-gitlab-token');
  if (!provided) return { valid: false, reason: 'missing_token' };
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'token_mismatch' };
  }
  return { valid: true };
}

export function parseGitlabDelivery(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  providerHostId: string,
  receivedAt: string,
): RawWebhookDelivery {
  const eventType = headerValue(headers, 'x-gitlab-event') ?? 'unknown';
  const deliveryId = headerValue(headers, 'x-gitlab-event-uuid');
  return {
    provider: 'gitlab',
    providerHostId,
    ...(deliveryId !== undefined ? { deliveryId } : {}),
    eventType,
    headers,
    body,
    receivedAt,
  };
}

interface GlProject {
  id: number;
  path_with_namespace: string;
  name: string;
  git_http_url?: string;
  default_branch?: string;
  namespace?: string;
}
interface GlUser {
  id: number;
  username: string;
  name?: string;
}
interface GlMergeRequestAttrs {
  id: number;
  iid: number;
  title?: string;
  action?: string;
  source_branch: string;
  target_branch: string;
  source_project_id?: number;
  target_project_id?: number;
  oldrev?: string;
  last_commit?: { id: string };
  work_in_progress?: boolean;
  /** Newer GitLab; older versions only send work_in_progress. */
  draft?: boolean;
  labels?: { title: string }[];
  updated_at?: string;
}

interface GlPipelineAttrs {
  status?: string;
  sha?: string;
}

const TERMINAL_PIPELINE_STATUSES = new Set(['success', 'failed', 'canceled', 'skipped', 'manual']);

function pipelineConclusion(status: string): string {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failure';
    case 'canceled':
      return 'cancelled';
    case 'manual':
      return 'action_required';
    default:
      return status;
  }
}

function toRepo(project: GlProject, hostId: string): ProviderRepoCoordinates {
  const [namespace, ...rest] = project.path_with_namespace.split('/');
  return {
    hostId,
    repoNativeId: String(project.id),
    namespace: namespace ?? project.namespace ?? '',
    name: rest.length > 0 ? rest.join('/') : project.name,
    ...(project.git_http_url ? { cloneUrl: project.git_http_url } : {}),
    ...(project.default_branch ? { defaultBranch: project.default_branch } : {}),
  };
}

function toChange(
  project: GlProject,
  attrs: GlMergeRequestAttrs,
  hostId: string,
): ProviderChangeCoordinates {
  return {
    repo: toRepo(project, hostId),
    number: attrs.iid,
    nativeId: String(attrs.id),
    kind: 'merge-request',
  };
}

function toActor(user: GlUser): { providerUserId: string; login: string; type: 'user' } {
  return { providerUserId: String(user.id), login: user.username, type: 'user' };
}

export function normalizeGitlabWebhook(raw: RawWebhookDelivery): ProviderWebhookEvent[] {
  const hostId = raw.providerHostId;
  let payload: {
    object_kind?: string;
    project?: GlProject;
    user?: GlUser;
    object_attributes?: GlMergeRequestAttrs &
      GlPipelineAttrs & {
        noteable_type?: string;
        note?: string;
        id?: number;
        iid?: number;
      };
    merge_request?: { iid: number; id: number };
    changes?: Record<string, { previous?: unknown; current?: unknown } | undefined>;
    ref?: string;
    before?: string;
    after?: string;
    checkout_sha?: string;
    build_status?: string;
    build_commit_sha?: string;
  };
  try {
    payload = JSON.parse(raw.body);
  } catch {
    return [{ type: 'ignored', reason: 'invalid_json' }];
  }

  const project = payload.project;
  const user = payload.user;

  switch (payload.object_kind) {
    case 'merge_request': {
      if (!project || !payload.object_attributes)
        return [{ type: 'ignored', reason: 'incomplete_mr' }];
      const attrs = payload.object_attributes;
      const occurredAt = attrs.updated_at;
      const change = toChange(project, attrs, hostId);
      const sourceIsFork =
        attrs.source_project_id !== undefined && attrs.target_project_id !== undefined
          ? attrs.source_project_id !== attrs.target_project_id
          : undefined;
      const title = typeof attrs.title === 'string' ? attrs.title : undefined;
      const actor = user
        ? toActor(user)
        : { providerUserId: '0', login: 'unknown', type: 'user' as const };
      switch (attrs.action) {
        case 'open':
          return [
            {
              type: 'change-request.opened',
              change,
              headSha: attrs.last_commit?.id ?? '',
              baseSha: '',
              sourceBranch: attrs.source_branch,
              targetBranch: attrs.target_branch,
              ...(sourceIsFork !== undefined ? { sourceIsFork } : {}),
              ...(title !== undefined ? { title } : {}),
              draft: attrs.draft ?? attrs.work_in_progress ?? false,
              actor,
              ...(occurredAt ? { occurredAt } : {}),
              ...(attrs.labels !== undefined ? { labels: attrs.labels.map((l) => l.title) } : {}),
            },
          ];
        case 'reopen':
          return [
            {
              type: 'change-request.reopened',
              change,
              actor,
              ...(occurredAt ? { occurredAt } : {}),
            },
          ];
        case 'close':
          return [
            { type: 'change-request.closed', change, actor, ...(occurredAt ? { occurredAt } : {}) },
          ];
        case 'merge':
          return [
            { type: 'change-request.merged', change, actor, ...(occurredAt ? { occurredAt } : {}) },
          ];
        case 'update': {
          const draftChange = payload.changes?.draft ?? payload.changes?.work_in_progress;
          const draft = attrs.draft ?? attrs.work_in_progress;
          // draft -> ready: head is unchanged, but auto reviews were skipped while in draft.
          if (draftChange?.previous === true && draftChange.current === false) {
            return [{ type: 'change-request.ready', change, actor, ...(occurredAt ? { occurredAt } : {}) }];
          }
          return [
            {
              type: 'change-request.updated',
              change,
              headSha: attrs.last_commit?.id ?? '',
              ...(attrs.oldrev ? { previousHeadSha: attrs.oldrev } : {}),
              baseSha: '',
              sourceBranch: attrs.source_branch,
              targetBranch: attrs.target_branch,
              ...(sourceIsFork !== undefined ? { sourceIsFork } : {}),
              ...(title !== undefined ? { title } : {}),
              reason: attrs.oldrev ? 'commit-pushed' : 'metadata-edited',
              ...(draft !== undefined ? { draft } : {}),
              actor,
              ...(occurredAt ? { occurredAt } : {}),
              ...(attrs.labels !== undefined ? { labels: attrs.labels.map((l) => l.title) } : {}),
            },
          ];
        }
        default:
          return [{ type: 'ignored', reason: `merge_request:${attrs.action ?? 'unknown'}` }];
      }
    }
    case 'note': {
      if (!project || !payload.object_attributes)
        return [{ type: 'ignored', reason: 'incomplete_note' }];
      const attrs = payload.object_attributes;
      const actor = user
        ? toActor(user)
        : { providerUserId: '0', login: 'unknown', type: 'user' as const };
      if (attrs.noteable_type === 'MergeRequest' && payload.merge_request) {
        const change = {
          repo: toRepo(project, hostId),
          number: payload.merge_request.iid,
          nativeId: String(payload.merge_request.id),
          kind: 'merge-request' as const,
        };
        // An edited note must not count as a new comment (it would re-run its command). GitLab's
        // update event carries neither the previous body nor the author name.
        if (attrs.action === 'update') {
          return [
            {
              type: 'comment.edited',
              change,
              commentNativeId: String(attrs.id ?? ''),
              body: attrs.note ?? '',
              actor,
            },
          ];
        }
        return [
          {
            type: 'comment.created',
            target: {
              kind: 'change-request',
              change: {
                repo: toRepo(project, hostId),
                number: payload.merge_request.iid,
                nativeId: String(payload.merge_request.id),
                kind: 'merge-request',
              },
            },
            commentNativeId: String(attrs.id ?? ''),
            body: attrs.note ?? '',
            actor,
          },
        ];
      }
      return [{ type: 'ignored', reason: `note:${attrs.noteable_type ?? 'unknown'}` }];
    }
    case 'push': {
      if (!project) return [{ type: 'ignored', reason: 'incomplete_push' }];
      const actor = user
        ? toActor(user)
        : { providerUserId: '0', login: 'unknown', type: 'user' as const };
      return [
        {
          type: 'push.received',
          repo: toRepo(project, hostId),
          ref: payload.ref ?? '',
          beforeSha: payload.before ?? '',
          afterSha: payload.after ?? payload.checkout_sha ?? '',
          actor,
        },
      ];
    }
    case 'pipeline': {
      if (!project || !payload.object_attributes)
        return [{ type: 'ignored', reason: 'incomplete_pipeline' }];
      const status = payload.object_attributes.status ?? '';
      const headSha = payload.object_attributes.sha ?? payload.checkout_sha ?? '';
      if (!TERMINAL_PIPELINE_STATUSES.has(status) || !headSha)
        return [{ type: 'ignored', reason: `pipeline:${status || 'unknown'}` }];
      return [
        {
          type: 'pipeline.completed',
          repo: toRepo(project, hostId),
          headSha,
          status: 'completed',
          conclusion: pipelineConclusion(status),
          ...(user ? { actor: toActor(user) } : {}),
        },
      ];
    }
    case 'build': {
      if (!project) return [{ type: 'ignored', reason: 'incomplete_build' }];
      const status = payload.build_status ?? '';
      const headSha = payload.build_commit_sha ?? payload.checkout_sha ?? '';
      if (!TERMINAL_PIPELINE_STATUSES.has(status) || !headSha)
        return [{ type: 'ignored', reason: `build:${status || 'unknown'}` }];
      return [
        {
          type: 'pipeline.completed',
          repo: toRepo(project, hostId),
          headSha,
          status: 'completed',
          conclusion: pipelineConclusion(status),
          ...(user ? { actor: toActor(user) } : {}),
        },
      ];
    }
    default:
      return [{ type: 'ignored', reason: `unhandled_event:${payload.object_kind ?? 'unknown'}` }];
  }
}
