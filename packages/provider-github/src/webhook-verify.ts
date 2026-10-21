import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RawWebhookDelivery, WebhookVerificationResult } from '@reviewbot/provider-contracts';

const SIGNATURE_HEADER = 'x-hub-signature-256';

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Verifies `X-Hub-Signature-256` with a constant-time comparison. */
export function verifyGithubWebhook(
  raw: RawWebhookDelivery,
  secret: string,
): WebhookVerificationResult {
  const provided = headerValue(raw.headers, SIGNATURE_HEADER);
  if (!provided) {
    return { valid: false, reason: 'missing_signature' };
  }
  if (!provided.startsWith('sha256=')) {
    return { valid: false, reason: 'unsupported_signature_scheme' };
  }
  const expected = `sha256=${createHmac('sha256', secret).update(raw.body, 'utf8').digest('hex')}`;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

export function parseGithubDelivery(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  providerHostId: string,
  receivedAt: string,
): RawWebhookDelivery {
  const eventType = headerValue(headers, 'x-github-event') ?? 'unknown';
  const deliveryId = headerValue(headers, 'x-github-delivery');
  return {
    provider: 'github',
    providerHostId,
    ...(deliveryId !== undefined ? { deliveryId } : {}),
    eventType,
    headers,
    body,
    receivedAt,
  };
}
