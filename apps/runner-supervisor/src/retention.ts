import type { ArtifactStore } from '@reviewbot/artifacts';
import { purgeCommandAudit } from '@reviewbot/command-gate';
import { uuidv7 } from '@reviewbot/ids';
import { completeErasure, DEFAULT_RETENTION, planInstallationErasure } from '@reviewbot/retention';
import type { LangfuseMetadataMatch, LangfuseTraceEraser } from '@reviewbot/telemetry';
import { purgeExpiredProgress } from './review-progress.js';
import type { JobHandler } from './supervisor.js';

/**
 * Retention and erasure jobs:
 * - retention_sweep: TTL cleanup of expired artifacts, deleting the object before the row (a failed object
 *   delete keeps the row for retry, so no orphaned objects); also purges expired `review_progress` rows.
 * - installation_erasure: on uninstall, erases all repository data (FK cascade) plus Langfuse LLM traces
 *   (which may hold customer source) and writes an audit erasure proof (audit is kept 1 year for compliance).
 */

export interface RetentionSweepPayload {
  tenantId: string;
}

export function createRetentionSweepHandler(deps: { store?: ArtifactStore; batch?: number } = {}): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as RetentionSweepPayload;
    const batch = deps.batch ?? 500;
    const now = new Date();
    const expired = await db
      .selectFrom('artifacts')
      .select(['id', 'storage_key'])
      .where('tenant_id', '=', payload.tenantId)
      .where('expires_at', 'is not', null)
      .where('expires_at', '<', now)
      .limit(batch)
      .execute();
    let deleted = 0;
    let storageFailures = 0;
    for (const a of expired) {
      try {
        await deps.store?.delete(a.storage_key);
      } catch {
        storageFailures += 1;
        continue; // object delete failed → keep row, retry next round
      }
      await db.deleteFrom('artifacts').where('id', '=', a.id).execute();
      deleted += 1;
    }
    if (expired.length > 0) log('retention sweep', { expired: expired.length, deleted, storageFailures });

    // review_progress and agent command audit: plain rows with no external object, one set-based DELETE each.
    const commandRule = DEFAULT_RETENTION['raw-command-logs'];
    if (typeof commandRule === 'number') {
      const commands = await purgeCommandAudit(db, payload.tenantId, commandRule, now);
      if (commands > 0) log('retention sweep: agent commands', { deleted: commands });
    }

    const progressRule = DEFAULT_RETENTION['review-progress'];
    if (typeof progressRule === 'number') {
      const progress = await purgeExpiredProgress(db, { tenantId: payload.tenantId, finishedDays: progressRule, now });
      if (progress.finished > 0 || progress.abandoned > 0) log('retention sweep: review progress', progress);
    }
  };
}

export interface InstallationErasurePayload {
  tenantId: string;
  installationId: string;
}

export interface InstallationErasureDeps {
  /**
   * Langfuse trace erasure; omitted when Langfuse is not configured. Never pass undefined when it is:
   * wiring uses `langfuseAdminFromEnv()`, which throws when configured but unresolvable.
   */
  langfuse?: LangfuseTraceEraser;
}

export function createInstallationErasureHandler(deps: InstallationErasureDeps = {}): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as InstallationErasurePayload;
    const inst = await db
      .selectFrom('installations')
      .select('id')
      .where('id', '=', payload.installationId)
      .where('tenant_id', '=', payload.tenantId)
      .executeTakeFirst();

    // Inventory for the erasure proof. Artifacts are not cascaded (tenant-level + object storage); the TTL sweep
    // clears them. On redelivery after deletion the inventory is gone, but the Langfuse step still runs.
    const repos = inst
      ? await db
          .selectFrom('repositories')
          .select(['id'])
          .where('installation_id', '=', payload.installationId)
          .execute()
      : [];

    /*
     * Langfuse must go before the DB delete: once the DB rows are gone, a retry takes the idempotent branch
     * and Langfuse is never retried. The reverse order is safe (re-deleting traces is idempotent).
     */
    const erasedTraces = await eraseLangfuseTraces(deps.langfuse, payload.installationId);

    if (!inst) {
      // Idempotent: already deleted on redelivery/retry. Still run the Langfuse step.
      log('installation erasure: already erased', { installationId: payload.installationId, llmTraces: erasedTraces });
      return;
    }

    const repoIds = repos.map((r) => r.id);
    const crCount = repoIds.length
      ? Number((await db.selectFrom('change_requests').select(db.fn.countAll().as('n')).where('repository_id', 'in', repoIds).executeTakeFirst())?.n ?? 0)
      : 0;
    const findingCount = repoIds.length
      ? Number((await db.selectFrom('findings').select(db.fn.countAll().as('n')).where('repository_id', 'in', repoIds).executeTakeFirst())?.n ?? 0)
      : 0;

    const task = planInstallationErasure(
      payload.installationId,
      {
        checkout: repoIds.length,
        'review-artifacts': crCount,
        'finding-metadata': findingCount,
        'llm-traces': erasedTraces ?? 0,
      },
      Date.now(),
    );
    // FK cascade: installations → repositories → change_requests/revisions/findings/settings/….
    await db.deleteFrom('installations').where('id', '=', payload.installationId).execute();
    const proof = completeErasure(task, Date.now());
    await db
      .insertInto('audit_events')
      .values({
        id: uuidv7(),
        tenant_id: payload.tenantId,
        actor: 'system',
        action: 'retention.installation-erased',
        target: payload.installationId,
        // `erasedCounts` only keeps count>0, so "no Langfuse" and "zero traces" would look alike;
        // a separate tri-state field (null = no backend) disambiguates.
        detail: { ...proof, llmTraces: { backend: deps.langfuse ? 'langfuse' : null, tracesRequested: erasedTraces } } as unknown as Record<string, unknown>,
        created_at: new Date(),
      })
      .execute();
    log('installation erased', { installationId: payload.installationId, repositories: repoIds.length, changeRequests: crCount, findings: findingCount, llmTraces: erasedTraces });
  };
}

/** Erases the installation's Langfuse traces (by span `installation` tag); returns the count requested, null without a backend. */
async function eraseLangfuseTraces(
  eraser: LangfuseTraceEraser | undefined,
  installationId: string,
): Promise<number | null> {
  if (!eraser) return null;
  const matches: LangfuseMetadataMatch[] = [{ key: 'installation', value: installationId }];
  // Throw on failure for a job retry; the DB is not deleted yet, so the retry covers the full path.
  return eraser.eraseByMetadata(matches);
}
