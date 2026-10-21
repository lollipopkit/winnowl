import { createHash } from 'node:crypto';
import type { ProviderKind } from '@reviewbot/domain';

/** Inbound raw webhook, persisted immutably. */
export interface RawWebhookDelivery {
  provider: ProviderKind;
  providerHostId: string;
  deliveryId?: string;
  /** Provider-native event name, e.g. GitHub's `pull_request`. */
  eventType: string;
  headers: Record<string, string | string[] | undefined>;
  /** Raw body, used for signature verification. */
  body: string;
  receivedAt: string;
}

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: string;
}

export interface DedupeKeyOptions {
  /** Native target id for the fallback key when there is no delivery id. */
  targetId?: string;
  /** Timestamp rounding for the fallback key (default 10s). */
  roundSeconds?: number;
}

/**
 * Prefers `provider_host_id + delivery_id`; otherwise falls back to
 * `host + event_type + target_id + payload_hash + rounded_timestamp`.
 */
export function webhookDedupeKey(
  delivery: RawWebhookDelivery,
  options: DedupeKeyOptions = {},
): string {
  if (delivery.deliveryId) {
    return `${delivery.provider}:${delivery.providerHostId}:${delivery.deliveryId}`;
  }
  const payloadHash = createHash('sha256').update(delivery.body, 'utf8').digest('hex').slice(0, 16);
  const round = options.roundSeconds ?? 10;
  const epoch = Date.parse(delivery.receivedAt);
  const roundedTs = Number.isNaN(epoch) ? 0 : Math.floor(epoch / 1000 / round) * round;
  const target = options.targetId ?? '-';
  return `${delivery.provider}:${delivery.providerHostId}:${delivery.eventType}:${target}:${payloadHash}:${roundedTs}`;
}

/** Provider-native coordinates, resolved to internal refs by webhook-ingress. */
export interface ProviderRepoCoordinates {
  hostId: string;
  repoNativeId: string;
  namespace: string;
  name: string;
  cloneUrl?: string;
  defaultBranch?: string;
}

export interface ProviderChangeCoordinates {
  repo: ProviderRepoCoordinates;
  number: number;
  nativeId: string;
  kind: 'pull-request' | 'merge-request';
}

/** Native stacked-PR info (GitHub); when absent, consumers infer stacks from branch topology. */
export interface ProviderStackInfo {
  id?: string;
  size?: number;
  /** 1-based. */
  position?: number;
  /** Final target branch of the whole stack (the root PR's base), not this PR's base. */
  baseRef?: string;
  baseSha?: string;
}

export interface ProviderActorInfo {
  providerUserId: string;
  login: string;
  type: 'user' | 'bot' | 'service';
}

/** Normalised webhook output: provider-native coordinates only, no internal UUIDs. */
export type ProviderWebhookEvent =
  | {
      type: 'change-request.opened';
      change: ProviderChangeCoordinates;
      headSha: string;
      baseSha: string;
      sourceBranch: string;
      targetBranch: string;
      /** Source branch lives in a fork; fork branches cannot be stacked on. */
      sourceIsFork?: boolean;
      title?: string;
      draft: boolean;
      actor: ProviderActorInfo;
      /** Provider-side lifecycle timestamp, used to reject delayed older deliveries. */
      occurredAt?: string;
      reviewers?: ProviderActorInfo[];
      labels?: string[];
      stack?: ProviderStackInfo;
    }
  | {
      type: 'change-request.updated';
      change: ProviderChangeCoordinates;
      headSha: string;
      previousHeadSha?: string;
      baseSha: string;
      sourceBranch?: string;
      targetBranch?: string;
      /** Source branch lives in a fork; fork branches cannot be stacked on. */
      sourceIsFork?: boolean;
      title?: string;
      reason: 'commit-pushed' | 'force-pushed' | 'base-updated' | 'metadata-edited';
      actor: ProviderActorInfo;
      /**
       * PR author (the actor is whoever labelled/pushed). Carried on every update so the CR row has an
       * author even when created by an update that arrived before `opened`.
       */
      author?: ProviderActorInfo;
      /** Provider-side lifecycle timestamp, used to reject delayed older deliveries. */
      occurredAt?: string;
      /** Full current set, not a delta. */
      reviewers?: ProviderActorInfo[];
      /** Full current set, not a delta. */
      labels?: string[];
      stack?: ProviderStackInfo;
      draft?: boolean;
    }
  | {
      type: 'change-request.reopened' | 'change-request.ready';
      change: ProviderChangeCoordinates;
      actor: ProviderActorInfo;
      /** Provider-side lifecycle timestamp, used to reject delayed older deliveries. */
      occurredAt?: string;
    }
  | {
      type: 'change-request.closed' | 'change-request.merged';
      change: ProviderChangeCoordinates;
      mergeCommitSha?: string;
      actor: ProviderActorInfo;
      /** Provider-side lifecycle timestamp, used to reject delayed older deliveries. */
      occurredAt?: string;
    }
  | {
      type: 'comment.created';
      target:
        | { kind: 'change-request'; change: ProviderChangeCoordinates }
        | { kind: 'issue'; repo: ProviderRepoCoordinates; number: number; nativeId: string };
      commentNativeId: string;
      body: string;
      actor: ProviderActorInfo;
      /** Set for inline review-thread comments, so commands can target the specific finding. */
      reviewThread?: { path?: string; threadNativeId?: string };
    }
  | {
      /** Edit of a top-level PR comment (used only for trigger checkboxes). */
      type: 'comment.edited';
      change: ProviderChangeCoordinates;
      commentNativeId: string;
      body: string;
      /** Absent on GitLab note updates. */
      previousBody?: string;
      /** Absent on GitLab, whose note events carry only the author id. */
      author?: ProviderActorInfo;
      /** Who made the edit. */
      actor: ProviderActorInfo;
    }
  | {
      type: 'push.received';
      repo: ProviderRepoCoordinates;
      ref: string;
      beforeSha: string;
      afterSha: string;
      actor: ProviderActorInfo;
    }
  | {
      type: 'issue.opened';
      repo: ProviderRepoCoordinates;
      number: number;
      nativeId: string;
      title: string;
      body: string;
      actor: ProviderActorInfo;
    }
  | {
      type: 'installation.changed';
      installationNativeId: string;
      action: 'created' | 'deleted' | 'suspended' | 'unsuspended' | 'repositories-changed';
    }
  | {
      type: 'pipeline.completed';
      repo: ProviderRepoCoordinates;
      headSha: string;
      status: string;
      conclusion: string;
      actor?: ProviderActorInfo;
    }
  | { type: 'ignored'; reason: string };

export type ProviderWebhookEventType = ProviderWebhookEvent['type'];
