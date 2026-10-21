import { uuidv7 } from '@reviewbot/ids';
import { evaluateWebhookDrift, readAppWebhookConfig, signAppJwt, type AppWebhookConfig } from '@reviewbot/provider-github';
import { recordWebhookConfigDrift } from '@reviewbot/telemetry';
import { githubAppTargets, type PeriodicSpec } from './scheduler.js';
import type { JobHandler } from './supervisor.js';

/**
 * `webhook_config_check`: a broken webhook is silent on our side (no requests, no errors), and the App
 * config drifts, so compare `GET /app/hook/config` against the expected URL; drift → audit + metric for
 * alerting. Expected URL derives from `API_BASE_URL` (fallback `CONSOLE_BASE_URL`); neither set → skip.
 */
export interface WebhookConfigCheckPayload {
  tenantId: string;
}

export interface WebhookConfigCheckDeps {
  /** App credentials; missing → skip. */
  appCredentials: () => Promise<{ appId: string; privateKeyPem: string } | null>;
  /** Expected webhook URL; missing → skip. */
  expectedUrl: () => string | undefined;
  /** Reads the actual config (injectable for tests). */
  readConfig?: (appJwt: string) => Promise<AppWebhookConfig>;
  now?: () => number;
}

export function createWebhookConfigCheckHandler(deps: WebhookConfigCheckDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as WebhookConfigCheckPayload;
    const expected = deps.expectedUrl();
    if (!expected) {
      log('webhook 配置巡检跳过:未设 API_BASE_URL / CONSOLE_BASE_URL(期望值未知,不猜基线)');
      return;
    }
    const creds = await deps.appCredentials();
    if (!creds) {
      log('webhook 配置巡检跳过:无 App 凭据');
      return;
    }

    const jwt = signAppJwt(creds.appId, creds.privateKeyPem, deps.now?.() ?? Date.now());
    // A read failure is "unknown", not drift; flagging it would make the alert noisy. Throw to let the job retry.
    const actual = await (deps.readConfig ?? defaultReadConfig)(jwt);
    const verdict = evaluateWebhookDrift(actual, expected);

    recordWebhookConfigDrift(verdict.drifted || verdict.insecure);

    if (verdict.reasons.length === 0) {
      log('webhook 配置巡检通过', { url: actual.url });
      return;
    }

    await db
      .insertInto('audit_events')
      .values({
        id: uuidv7(),
        tenant_id: payload.tenantId,
        actor: 'system',
        action: 'webhook.config-drift',
        target: creds.appId,
        detail: {
          actual: verdict.actual,
          expected: verdict.expected,
          drifted: verdict.drifted,
          insecure: verdict.insecure,
          reasons: verdict.reasons,
        } as unknown as Record<string, unknown>,
        created_at: new Date(),
      })
      .execute();
    // Error level on purpose: this failure mode is otherwise silent for days.
    log('⚠️ webhook 配置漂移', { actual: verdict.actual, expected: verdict.expected, reasons: verdict.reasons });
  };
}

async function defaultReadConfig(appJwt: string): Promise<AppWebhookConfig> {
  const { RestClient } = await import('@reviewbot/provider-http');
  const client = new RestClient({ baseUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com', userAgent: 'winnowl' });
  return readAppWebhookConfig(client, appJwt);
}

/** App-level check: one per App (per-tenant would write N identical drift audits). */
export function webhookConfigCheckSpec(everyMs: number): PeriodicSpec {
  return { type: 'webhook_config_check', everyMs, targets: githubAppTargets };
}
