import type { Db } from '@reviewbot/db';
import type { ProviderKind } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import { webhookDedupeKey } from '@reviewbot/provider-contracts';
import { persistDomainEvent } from './persist.js';
import { scheduleFromHints, type ScheduleHint } from './schedule.js';
import type {
  ContextResolver,
  IngestInput,
  IngestResult,
  SecretResolver,
  WebhookAdapter,
} from './types.js';

export interface WebhookIngestorOptions {
  db: Db;
  adapters: Partial<Record<ProviderKind, WebhookAdapter>>;
  resolveContext: ContextResolver;
  resolveSecret: SecretResolver;
  /** Called when context resolution misses; true = provisioned, retry resolution. The hook verifies the signature itself. */
  provision?: (input: IngestInput) => Promise<boolean>;
  now?: () => number;
}

/** verify -> persist immutable raw event -> dedupe -> normalize -> persist domain state. */
export class WebhookIngestor {
  constructor(private readonly options: WebhookIngestorOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async handle(input: IngestInput): Promise<IngestResult> {
    const adapter = this.options.adapters[input.provider];
    if (!adapter) return { status: 'unresolved' };

    let ctx = await this.options.resolveContext(input);
    if (!ctx && this.options.provision && (await this.options.provision(input))) {
      ctx = await this.options.resolveContext(input);
    }
    if (!ctx) return { status: 'unresolved' };

    const secret = await this.options.resolveSecret(ctx);
    if (!secret) return { status: 'unauthorized', reason: 'no_secret' };

    const raw = adapter.parse(input.headers, input.body, ctx.providerHostId, input.receivedAt);
    const verification = adapter.verify(raw, secret);
    const dedupeKey = webhookDedupeKey(raw);
    const nowDate = new Date(this.now());

    // Only verified deliveries take the dedupe key; rejected ones use a prefixed key so a valid redelivery
    // with the same delivery id is not dropped as a duplicate.
    const verified = verification.valid;
    const dedupe = verified ? dedupeKey : `rejected:${dedupeKey}`;

    return this.options.db.transaction().execute(async (trx) => {
      // Raw event, domain state and jobs commit together; otherwise a retry would hit the dedupe key and lose side effects.
      const inserted = await trx
        .insertInto('provider_events')
        .values({
          id: uuidv7(this.now()),
          tenant_id: ctx.tenantId,
          provider: input.provider,
          provider_host_id: ctx.providerHostId,
          installation_id: ctx.installationId,
          delivery_id: raw.deliveryId ?? null,
          event_type: raw.eventType,
          dedupe_key: dedupe,
          signature_valid: verified,
          headers: sanitizeHeaders(input.headers),
          body: input.body,
          received_at: nowDate,
          created_at: nowDate,
        })
        .onConflict((oc) => oc.column('dedupe_key').doNothing())
        .returning('id')
        .executeTakeFirst();

      // Signature failed: keep the raw audit row only.
      if (!verified) {
        return {
          status: 'unauthorized',
          reason: verification.reason ?? 'invalid_signature',
        } as const;
      }

      if (!inserted) return { status: 'duplicate' } as const;

      const events = adapter.normalize(raw);
      const domainEventIds: string[] = [];
      const hints: ScheduleHint[] = [];
      for (const event of events) {
        if (event.type === 'ignored') continue;
        const { domainEventId, schedules } = await persistDomainEvent(
          trx,
          ctx,
          inserted.id,
          event,
          nowDate,
        );
        domainEventIds.push(domainEventId);
        hints.push(...schedules);
      }

      const scheduledJobIds = await scheduleFromHints(trx, hints);
      return {
        status: 'accepted',
        providerEventId: inserted.id,
        domainEventIds,
        scheduledJobIds,
      } as const;
    });
  }
}

/** Strips Authorization and signature headers. */
function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, unknown> {
  const drop = new Set([
    'authorization',
    'x-hub-signature',
    'x-hub-signature-256',
    'x-gitlab-token',
    'x-gitea-signature',
    'x-forgejo-signature',
    'cookie',
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (drop.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}
