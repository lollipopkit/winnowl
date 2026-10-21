import { syncModelCatalog } from '@reviewbot/entitlement';
import type { Db } from '@reviewbot/db';
import { createResolveListRepositories } from '@reviewbot/provider-factory';
import { createSyncInstallationHandler } from '../sync-installation.js';
import { createCrossTenantIntakeHandler } from '../cross-tenant-notify.js';
import {
  createWebhookConfigCheckHandler,
  webhookConfigCheckSpec,
} from '../webhook-config-check.js';
import { createWebhookRedeliverHandler, webhookRedeliverSpec } from '../webhook-redeliver.js';
import { createRelationshipDiscoverHandler } from '../relationship-discover.js';
import { consoleBaseUrl, githubWebhookUrl } from '@reviewbot/config';
import { createInstallationErasureHandler, createRetentionSweepHandler } from '../retention.js';
import { DAYS, MINUTES, tenantTargets, type PeriodicSpec } from '../scheduler.js';
import { createNotificationEmailHandler } from '../notification-email.js';
import type { JobHandler } from '../supervisor.js';
import type { RunnerRuntime } from './runtime.js';
import type { Logger } from 'pino';

/** Installation sync, retention and erasure, webhook upkeep, notifications, relationship discovery. */
export function maintenanceHandlers(rt: RunnerRuntime): Record<string, JobHandler> {
  const {
    db,
    credentialStore,
    githubAppCredentials,
    artifactStore,
    langfuseAdmin,
    buildProviderForRepository,
    openCodePlane,
    repositoryReadToken,
    notificationMailer,
  } = rt;

  return {
    sync_installation: createSyncInstallationHandler({
      resolveListRepositories: createResolveListRepositories({ db, store: credentialStore }),
    }),
    retention_sweep: createRetentionSweepHandler({
      ...(artifactStore ? { store: artifactStore } : {}),
    }),
    // Uninstall also erases Langfuse traces (they hold customer source with LLM_TRACE_BODIES).
    // `langfuseAdminFromEnv` throws on a misconfiguration: failing to start beats a false erasure claim.
    installation_erasure: createInstallationErasureHandler({
      ...(langfuseAdmin ? { langfuse: langfuseAdmin } : {}),
    }),
    // Webhook delivery stopping is silent on our side; the only signal is the GitHub-side config.
    webhook_config_check: createWebhookConfigCheckHandler({
      appCredentials: githubAppCredentials,
      expectedUrl: () => githubWebhookUrl(process.env),
    }),
    // Ask GitHub to redeliver failed deliveries (events during a restart or ingress timeout are otherwise lost).
    webhook_redeliver: createWebhookRedeliverHandler({
      appCredentials: githubAppCredentials,
      lookbackMs: Number(process.env.WEBHOOK_REDELIVER_LOOKBACK_HOURS ?? 6) * 60 * MINUTES,
      maxAttempts: 3,
    }),
    // Cross-tenant notify jobs belong to the downstream tenant and use its own credentials; intake reads
    // the event table both sides can see. Neither reads code or needs an RLS escape hatch.
    notification_email: createNotificationEmailHandler({
      ...(notificationMailer ? { mailer: notificationMailer } : {}),
      ...(consoleBaseUrl(process.env) ? { consoleBaseUrl: consoleBaseUrl(process.env)! } : {}),
    }),
    cross_tenant_intake: createCrossTenantIntakeHandler({
      buildProvider: (repositoryId: string) => buildProviderForRepository(repositoryId),
      notificationLink: ({ targetRepositoryId }) => `/repositories?highlight=${targetRepositoryId}`,
    }),
    // Relationship discovery: shallow clone, read manifests, propose deterministically (no LLM).
    relationship_discover: createRelationshipDiscoverHandler({
      // Shallow workspaces, opened and closed per repository within the job.
      openRepository: async (repo) =>
        openCodePlane({
          cloneUrl: repo.cloneUrl,
          token: await repositoryReadToken(repo.installationId, repo.nativeId),
          depth: 1,
        }),
      ...(process.env.RELATIONSHIP_DISCOVER_MAX_REPOS
        ? { maxRepos: Number(process.env.RELATIONSHIP_DISCOVER_MAX_REPOS) }
        : {}),
    }),
  };
}

/**
 * Periodic jobs, ticked every minute; runPeriodicEnqueue enqueues each bucket key once (the dedupe
 * index only covers in-flight jobs). Scheduled security scans and relationship discovery are off by
 * default because of their cost.
 */
export function periodicSpecs(): PeriodicSpec[] {
  return [
    {
      type: 'retention_sweep',
      everyMs: 1 * DAYS,
      targets: tenantTargets(),
    },
    {
      type: 'security_scan',
      everyMs: Number(process.env.SECURITY_SCAN_INTERVAL_DAYS ?? 0) * DAYS,
      targets: async (database) =>
        (await database.selectFrom('repositories').select(['id', 'tenant_id']).execute()).map(
          (r) => ({
            tenantId: r.tenant_id,
            key: r.id,
            payload: { tenantId: r.tenant_id, repositoryId: r.id, trigger: 'scheduled' },
          }),
        ),
    },
    webhookConfigCheckSpec(Number(process.env.WEBHOOK_CONFIG_CHECK_INTERVAL_DAYS ?? 1) * DAYS),
    webhookRedeliverSpec(Number(process.env.WEBHOOK_REDELIVER_INTERVAL_MINUTES ?? 10) * MINUTES),
    {
      // Every 5 minutes by default; the bucket key keeps the minute tick from enqueuing duplicates.
      type: 'cross_tenant_intake',
      everyMs: Number(process.env.CROSS_TENANT_INTAKE_INTERVAL_MINUTES ?? 5) * MINUTES,
      targets: tenantTargets(),
    },
    {
      // Without SMTP the handler is a no-op and notifications stay in-app.
      type: 'notification_email',
      everyMs: Number(process.env.NOTIFICATION_EMAIL_INTERVAL_MINUTES ?? 5) * MINUTES,
      targets: tenantTargets(),
    },
    {
      type: 'relationship_discover',
      everyMs: Number(process.env.RELATIONSHIP_DISCOVER_INTERVAL_DAYS ?? 0) * DAYS,
      targets: tenantTargets({ trigger: 'scheduled' }),
    },
  ];
}

/*
 * Daily model catalog sync. The catalog is platform-wide, so it bypasses the per-tenant `periodicSpecs`
 * and uses max(`synced_at`) as its schedule; concurrent instances at worst sync twice (each sync replaces
 * the source in a transaction). MODEL_CATALOG_SYNC_INTERVAL_HOURS=0 disables it (offline deployments).
 */
const CATALOG_SYNC_INTERVAL_MS =
  Number(process.env.MODEL_CATALOG_SYNC_INTERVAL_HOURS ?? 24) * 60 * 60 * 1000;

async function syncModelCatalogIfStale(db: Db, logger: Logger): Promise<void> {
  if (!(CATALOG_SYNC_INTERVAL_MS > 0)) return;
  const last = await db
    .selectFrom('model_catalog')
    .select((eb) => eb.fn.max('synced_at').as('t'))
    .executeTakeFirst();
  const lastMs = last?.t ? new Date(last.t as unknown as string).getTime() : 0;
  if (Date.now() - lastMs < CATALOG_SYNC_INTERVAL_MS) return;
  const r = await syncModelCatalog(db);
  // Price changes matter on their own: the registry may point at these entries and the cost gate uses them.
  logger.info(
    { total: r.total, removed: r.removed, repriced: r.repriced.length },
    '模型元数据目录已同步',
  );
  for (const c of r.repriced) {
    logger.warn(
      { model: `${c.provider}/${c.modelId}`, from: c.from, to: c.to },
      '模型元数据价格变动',
    );
  }
}

/** Syncs the model catalog now and hourly when stale; returns the timer to clear on shutdown. */
export function startModelCatalogSync(db: Db, logger: Logger): NodeJS.Timeout {
  const catalogTimer = setInterval(
    () => {
      void syncModelCatalogIfStale(db, logger).catch((err) =>
        logger.warn({ err: (err as Error)?.message }, '模型元数据目录同步失败'),
      );
    },
    60 * 60 * 1000,
  );
  catalogTimer.unref();
  // Try once at startup; a no-op while the catalog is fresh.
  void syncModelCatalogIfStale(db, logger).catch((err) =>
    logger.warn({ err: (err as Error)?.message }, '模型元数据目录同步失败'),
  );
  return catalogTimer;
}
