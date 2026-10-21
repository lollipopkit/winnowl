import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import type { Db } from '@reviewbot/db';
import {
  failCrossTenantEvent,
  markCrossTenantEventConsumed,
  pendingCrossTenantEvents,
  type CrossTenantEvent,
} from '@reviewbot/multi-repo';
import { createNotification } from '@reviewbot/notifications';
import { uuidv7 } from '@reviewbot/ids';
import { JobExecutionError, type JobHandler } from './supervisor.js';
import { botName } from '@reviewbot/domain';
import { repositoryRefFromRow } from './repository-ref.js';

/**
 * `cross_tenant_intake`, downstream side. Each side reads/writes only in its own tenant context (no RLS
 * escape hatch): upstream inserts `cross_tenant_events`, downstream selects its own, notifies, files an
 * issue and marks it consumed. Events are accounted individually: one failing delivery backs off or is
 * abandoned without blocking the events after it.
 */
export interface CrossTenantIntakePayload {
  /** Downstream tenant; the job runs in its context. */
  tenantId: string;
}

export interface CrossTenantIntakeDeps {
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
  /** Console-relative link base for notifications; omitted → no link. */
  notificationLink?: (event: { targetRepositoryId: string }) => string | undefined;
  /** Also file an issue in the downstream repo (default true). */
  createIssue?: boolean;
}

type Log = (msg: string, detail?: Record<string, unknown>) => void;

export function createCrossTenantIntakeHandler(deps: CrossTenantIntakeDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as CrossTenantIntakePayload;
    if (payload.tenantId !== job.tenantId) {
      throw new JobExecutionError(
        'cross_tenant_intake tenantId does not match the claimed job tenant',
        'configuration_invalid',
        false,
      );
    }
    const tenantId = job.tenantId;
    const events = await pendingCrossTenantEvents(db, tenantId);
    if (events.length === 0) return;

    let delivered = 0;
    let retrying = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await deliverEvent(deps, db, log, tenantId, event);
        delivered += 1;
      } catch (error) {
        const outcome = await failCrossTenantEvent(db, event.id, tenantId, error);
        const message = (error as Error)?.message ?? String(error);
        if (!outcome?.failed) {
          // Already consumed/abandoned elsewhere, or taken by a concurrent intake: not an error.
          retrying += 1;
          log('cross-tenant intake: 投递失败,已排入下次重试', {
            eventId: event.id,
            attempts: outcome?.attempts ?? null,
            error: message,
          });
          continue;
        }
        failed += 1;
        log('cross-tenant intake: 投递放弃(已达尝试上限)', {
          eventId: event.id,
          attempts: outcome.attempts,
          error: message,
        });
        // Notification failure must not fail the round.
        await reportUndeliverable(db, log, tenantId, event, message, outcome.attempts).catch(
          (reportError: unknown) => {
            log('cross-tenant intake: 放弃事件的通知也没发出去', {
              eventId: event.id,
              error: (reportError as Error)?.message ?? String(reportError),
            });
          },
        );
      }
    }
    log('cross-tenant intake 完成', { tenantId, events: events.length, delivered, retrying, failed });
  };
}

/** Delivers one event; throws on failure so the caller does the accounting. */
async function deliverEvent(
  deps: CrossTenantIntakeDeps,
  db: Db,
  log: Log,
  tenantId: string,
  ev: CrossTenantEvent,
): Promise<void> {
  const contractPaths = Array.isArray(ev.payload.contractPaths)
    ? (ev.payload.contractPaths as string[])
    : [];
  const sourceRevisionId = String(ev.payload.sourceRevisionId ?? '');

  // The target repo must belong to this tenant (stops forged events from notifying elsewhere).
  const repo = await db
    .selectFrom('repositories')
    .selectAll()
    .where('id', '=', ev.targetRepositoryId)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  if (!repo) {
    log('cross-tenant intake: 目标仓不属本租户,跳过', { eventId: ev.id });
    await markCrossTenantEventConsumed(db, ev.id, tenantId);
    return;
  }

  const paths = contractPaths.slice(0, 20);
  const label = `${repo.namespace}/${repo.name}`;
  const link = deps.notificationLink?.({ targetRepositoryId: ev.targetRepositoryId });
  const body = [
    '上游仓库的契约面发生变更,可能影响本仓库。',
    '',
    '变更的契约文件:',
    ...paths.map((p) => `- \`${p}\``),
    ...(contractPaths.length > paths.length
      ? [`- (另有 ${contractPaths.length - paths.length} 个未列出)`]
      : []),
    '',
    `_本通知来自跨租户关系(双方均已确认);${botName()} 未读取本仓库代码,也未向上游回传本仓库任何内容。_`,
  ].join('\n');

  // In-app notification; dedupeKey prevents spam when the periodic task sees the same event again.
  await createNotification(db, {
    tenantId,
    kind: 'cross-tenant-contract-change',
    title: `上游契约变更影响 ${label}`,
    body,
    ...(link ? { link } : {}),
    payload: {
      relationshipId: ev.relationshipId,
      repositoryId: ev.targetRepositoryId,
      contractPaths: paths,
    },
    dedupeKey: `xtenant:${ev.relationshipId}:${sourceRevisionId}`,
  });

  // Downstream issue with this tenant's own installation token. Failure is thrown for accounting; the
  // event stays pending with its own backoff.
  if (deps.createIssue !== false) {
    const repoRef = repositoryRefFromRow(repo);
    const provider = await deps.buildProvider(ev.targetRepositoryId);
    await provider.issues.create(
      repoRef,
      {
        title: `[${botName()}] 上游契约变更`,
        body: { markdown: body },
        labels: [botName(), 'upstream-contract'],
      },
      { key: `cross-tenant-notify:${ev.relationshipId}:${sourceRevisionId}` },
    );
  }

  // Consumption and audit commit together; only the transaction that claims the unconsumed event audits.
  await db.transaction().execute(async (trx) => {
    const consumed = await markCrossTenantEventConsumed(trx, ev.id, tenantId);
    if (!consumed) return;
    await trx
      .insertInto('audit_events')
      .values({
        id: uuidv7(),
        tenant_id: tenantId,
        actor: 'cross-tenant',
        action: 'cross-tenant.notified',
        target: ev.targetRepositoryId,
        detail: {
          relationshipId: ev.relationshipId,
          contractPaths: paths,
          sourceRevisionId,
        } as unknown as Record<string, unknown>,
        created_at: new Date(),
      })
      .execute();
  });
}

/** After giving up: in-app notification + audit explaining why there is no issue. */
async function reportUndeliverable(
  db: Db,
  log: Log,
  tenantId: string,
  ev: CrossTenantEvent,
  message: string,
  attempts: number,
): Promise<void> {
  const repo = await db
    .selectFrom('repositories')
    .select(['namespace', 'name'])
    .where('id', '=', ev.targetRepositoryId)
    .executeTakeFirst();
  const label = repo ? `${repo.namespace}/${repo.name}` : ev.targetRepositoryId;
  await createNotification(db, {
    tenantId,
    kind: 'cross-tenant-contract-change-undeliverable',
    title: `上游契约变更通知未能建 issue(${label})`,
    body: [
      `上游仓库的契约面有变更,但连续 ${attempts} 次都没能在本仓库建出 issue。`,
      '',
      `原因:${message}`,
      '',
      '站内通知已送达,事件不再重试。常见原因是仓库关闭了 issue,或 bot 没有写权限。',
      `_本通知来自跨租户关系;${botName()} 未读取本仓库代码。_`,
    ].join('\n'),
    payload: {
      relationshipId: ev.relationshipId,
      repositoryId: ev.targetRepositoryId,
      attempts,
    },
    dedupeKey: `xtenant-undeliverable:${ev.relationshipId}:${ev.id}`,
  });
  log('cross-tenant intake: 已告知租户该事件不再重试', { eventId: ev.id });
  await db
    .insertInto('audit_events')
    .values({
      id: uuidv7(),
      tenant_id: tenantId,
      actor: 'cross-tenant',
      action: 'cross-tenant.undeliverable',
      target: ev.targetRepositoryId,
      detail: {
        relationshipId: ev.relationshipId,
        attempts,
        error: message,
      } as unknown as Record<string, unknown>,
      created_at: new Date(),
    })
    .execute();
}
