import type { ProviderKind } from '@reviewbot/domain';
import type {
  ProviderWebhookEvent,
  RawWebhookDelivery,
  WebhookVerificationResult,
} from '@reviewbot/provider-contracts';

export interface IngestContext {
  provider: ProviderKind;
  tenantId: string;
  providerHostId: string;
  installationId: string;
}

export interface WebhookAdapter {
  parse(
    headers: Record<string, string | string[] | undefined>,
    body: string,
    providerHostId: string,
    receivedAt: string,
  ): RawWebhookDelivery;
  verify(raw: RawWebhookDelivery, secret: string): WebhookVerificationResult;
  normalize(raw: RawWebhookDelivery): ProviderWebhookEvent[];
}

export interface IngestInput {
  provider: ProviderKind;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  receivedAt: string;
  /** Internal installation id from the path (GitLab/Forgejo). */
  pathInstallationId?: string;
}

export type IngestResult =
  | { status: 'accepted'; providerEventId: string; domainEventIds: string[]; scheduledJobIds: string[] }
  | { status: 'duplicate' }
  | { status: 'unauthorized'; reason: string }
  | { status: 'unresolved' };

export type ContextResolver = (input: IngestInput) => Promise<IngestContext | null>;

export type SecretResolver = (ctx: IngestContext) => Promise<string | null>;
