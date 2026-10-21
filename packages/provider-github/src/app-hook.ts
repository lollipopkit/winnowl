import { createSign } from 'node:crypto';
import type { RestClient } from '@reviewbot/provider-http';

/**
 * Periodic check of the App's webhook config. The hook URL can drift, and then our own logs stay
 * clean (no requests, no errors); the only signal is on GitHub's side.
 */

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function signAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - 30;
  const exp = iat + 9 * 60;
  const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ iat, exp, iss: appId }),
  )}`;
  return `${signingInput}.${base64url(createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem))}`;
}

export interface AppWebhookConfig {
  url: string;
  contentType?: string;
  insecureSsl?: string;
}

/** GitHub never returns the secret (only `********`). */
export async function readAppWebhookConfig(client: RestClient, appJwt: string): Promise<AppWebhookConfig> {
  const res = await client.get<{ url?: string; content_type?: string; insecure_ssl?: string }>('app/hook/config', {
    headers: { authorization: `Bearer ${appJwt}` },
  });
  return {
    url: res.data.url ?? '',
    ...(res.data.content_type ? { contentType: res.data.content_type } : {}),
    ...(res.data.insecure_ssl ? { insecureSsl: res.data.insecure_ssl } : {}),
  };
}

export interface WebhookDriftVerdict {
  drifted: boolean;
  actual: string;
  expected: string;
  /** Not https: plaintext delivery would leak payloads. */
  insecure: boolean;
  reasons: string[];
}

/** Strips trailing slashes and lowercases only the host (paths are case-sensitive). */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}

/** Normalises only trailing slash and host case; anything looser could hide a real drift. */
export function evaluateWebhookDrift(actual: AppWebhookConfig, expectedUrl: string): WebhookDriftVerdict {
  const a = normalizeUrl(actual.url);
  const e = normalizeUrl(expectedUrl);
  const reasons: string[] = [];
  const drifted = a !== e;
  if (drifted) reasons.push(`webhook url 与期望不符:实际 ${actual.url || '(空)'} / 期望 ${expectedUrl}`);
  const insecure = a.startsWith('http://') || actual.insecureSsl === '1';
  if (insecure) reasons.push('webhook 未强制 https(明文投递会泄露 payload 与签名)');
  return { drifted, actual: actual.url, expected: expectedUrl, insecure, reasons };
}

/** Redeliveries of one event share a `guid`. */
export interface HookDelivery {
  /** Decimal string: ids exceed 2^53, and a rounded number would make redelivery 404. */
  id: string;
  guid: string;
  deliveredAt: string;
  event: string;
  action?: string;
  statusCode: number;
  redelivery: boolean;
}

/** Newest first, paged by the `cursor` from the `next` link (path and auth stay our own). */
export async function listHookDeliveries(
  client: RestClient,
  appJwt: string,
  sinceIso: string,
  maxPages = 20,
): Promise<HookDelivery[]> {
  const out: HookDelivery[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await client.get<string>('app/hook/deliveries', {
      headers: { authorization: `Bearer ${appJwt}` },
      query: { per_page: 100, ...(cursor ? { cursor } : {}) },
      raw: true,
    });
    const list = parseHookDeliveries(res.data);
    for (const d of list) {
      if (d.delivered_at < sinceIso) return out;
      out.push({
        id: d.id,
        guid: d.guid,
        deliveredAt: d.delivered_at,
        event: d.event,
        ...(d.action ? { action: d.action } : {}),
        statusCode: d.status_code,
        redelivery: d.redelivery,
      });
    }
    cursor = nextCursor(res.headers.get('link'));
    if (!cursor || list.length === 0) return out;
  }
  return out;
}

interface RawHookDelivery {
  id: string;
  guid: string;
  delivered_at: string;
  event: string;
  action?: string | null;
  status_code: number;
  redelivery: boolean;
}

/** Parses a deliveries page keeping each `id` as its exact source digits (see `HookDelivery.id`). */
export function parseHookDeliveries(text: string): RawHookDelivery[] {
  if (!text) return [];
  const reviver = (key: string, value: unknown, context?: { source?: string }): unknown =>
    key === 'id' && typeof value === 'number' && context?.source !== undefined ? context.source : value;
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown) as RawHookDelivery[];
}

function nextCursor(link: string | null): string | undefined {
  for (const part of link?.split(',') ?? []) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (!match) continue;
    try {
      return new URL(match[1]!).searchParams.get('cursor') ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function redeliverHookDelivery(client: RestClient, appJwt: string, deliveryId: string): Promise<void> {
  await client.post(`app/hook/deliveries/${deliveryId}/attempts`, { headers: { authorization: `Bearer ${appJwt}` } });
}

/** Guids with no 2xx attempt and attempts below the limit; redelivers each guid's latest attempt. */
export function deliveriesToRedeliver(deliveries: readonly HookDelivery[], maxAttempts: number): HookDelivery[] {
  const byGuid = new Map<string, HookDelivery[]>();
  for (const d of deliveries) byGuid.set(d.guid, [...(byGuid.get(d.guid) ?? []), d]);
  const out: HookDelivery[] = [];
  for (const attempts of byGuid.values()) {
    if (attempts.some((a) => a.statusCode >= 200 && a.statusCode < 300)) continue;
    if (attempts.length >= maxAttempts) continue;
    out.push(attempts.reduce((a, b) => (a.deliveredAt >= b.deliveredAt ? a : b)));
  }
  return out;
}
