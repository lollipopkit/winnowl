import {
  deliveriesToRedeliver,
  listHookDeliveries,
  redeliverHookDelivery,
  signAppJwt,
  type HookDelivery,
} from '@reviewbot/provider-github';
import { githubAppTargets, type PeriodicSpec } from './scheduler.js';
import type { JobHandler } from './supervisor.js';

/**
 * `webhook_redeliver`: asks GitHub to redeliver failed webhook deliveries, since GitHub never retries
 * them (events arriving during a restart are otherwise lost). Ingress dedupes by delivery guid.
 */
export interface WebhookRedeliverDeps {
  appCredentials: () => Promise<{ appId: string; privateKeyPem: string } | null>;
  /** Much longer than the sweep interval, so the first run after an outage covers all of it. */
  lookbackMs: number;
  /** Attempts per event including the first delivery; beyond that give up and log. */
  maxAttempts: number;
  list?: (appJwt: string, sinceIso: string) => Promise<HookDelivery[]>;
  redeliver?: (appJwt: string, deliveryId: string) => Promise<void>;
  now?: () => number;
}

export function createWebhookRedeliverHandler(deps: WebhookRedeliverDeps): JobHandler {
  return async ({ log }) => {
    const creds = await deps.appCredentials();
    if (!creds) {
      log('webhook 重投跳过:无 App 凭据');
      return;
    }
    const now = deps.now?.() ?? Date.now();
    const jwt = signAppJwt(creds.appId, creds.privateKeyPem, now);
    const since = new Date(now - deps.lookbackMs).toISOString();
    const deliveries = await (deps.list ?? defaultList)(jwt, since);
    const todo = deliveriesToRedeliver(deliveries, deps.maxAttempts);
    let requested = 0;
    for (const d of todo) {
      try {
        await (deps.redeliver ?? defaultRedeliver)(jwt, d.id);
        requested += 1;
      } catch (error) {
        log('webhook 重投请求失败', { deliveryId: d.id, event: d.event, error: (error as Error).message });
      }
    }
    const failedGuids = new Set(
      deliveries.filter((d) => d.statusCode < 200 || d.statusCode >= 300).map((d) => d.guid),
    );
    if (failedGuids.size > 0 || requested > 0) {
      log('webhook 重投', {
        failedEvents: failedGuids.size,
        requested,
        events: todo.map((d) => `${d.event}${d.action ? `.${d.action}` : ''}`),
      });
    }
  };
}

async function client() {
  const { RestClient } = await import('@reviewbot/provider-http');
  return new RestClient({ baseUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com', userAgent: 'winnowl' });
}

async function defaultList(appJwt: string, sinceIso: string): Promise<HookDelivery[]> {
  return listHookDeliveries(await client(), appJwt, sinceIso);
}

async function defaultRedeliver(appJwt: string, deliveryId: string): Promise<void> {
  await redeliverHookDelivery(await client(), appJwt, deliveryId);
}

/** App-level task: enqueued once per App (see `githubAppTargets`). */
export function webhookRedeliverSpec(everyMs: number): PeriodicSpec {
  return { type: 'webhook_redeliver', everyMs, targets: githubAppTargets };
}
