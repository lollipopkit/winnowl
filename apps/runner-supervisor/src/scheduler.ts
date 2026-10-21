import { enqueueJob } from '@reviewbot/queue';
import { sql, type Db } from '@reviewbot/db';

/**
 * Periodic job enqueueing. `dedupeKey` alone is not enough: the jobs unique index only covers in-flight
 * statuses, so a completed job's key can be enqueued again. Instead, skip when a row with the period
 * bucket's dedupeKey exists in any status.
 */

export interface PeriodicTarget {
  tenantId: string;
  /** Stable target id in the dedupeKey (e.g. tenantId / repositoryId). */
  key: string;
  payload: Record<string, unknown>;
}

export interface PeriodicSpec {
  /** Job type (also the dedupeKey prefix). */
  type: string;
  /** Period in ms (allows minute-level tasks); <=0 disables it. */
  everyMs: number;
  /** Targets for this round; empty means nothing to do. */
  targets: (db: Db) => Promise<PeriodicTarget[]>;
}

/** One target per tenant (payload carries tenantId plus `extra`). */
export function tenantTargets(extra: Record<string, unknown> = {}): PeriodicSpec['targets'] {
  return async (database) =>
    (await database.selectFrom('tenants').select('id').execute()).map((t) => ({
      tenantId: t.id,
      key: t.id,
      payload: { tenantId: t.id, ...extra },
    }));
}

/**
 * App-level targets: one per App, under the earliest tenant holding the GitHub host (the job only calls
 * the GitHub App API; per-tenant would repeat it N times).
 */
export async function githubAppTargets(database: Db): Promise<PeriodicTarget[]> {
  const host = await database
    .selectFrom('provider_hosts')
    .select('tenant_id')
    .where('provider', '=', 'github')
    .orderBy('created_at')
    .executeTakeFirst();
  return host ? [{ tenantId: host.tenant_id, key: 'app', payload: { tenantId: host.tenant_id } }] : [];
}

/** Period bucket aligned to the UTC epoch, so restarts do not shift it. */
export function periodBucket(nowMs: number, everyMs: number): number {
  return Math.floor(nowMs / everyMs);
}

export const DAYS = 24 * 60 * 60 * 1000;
export const MINUTES = 60 * 1000;

export interface PeriodicRunResult {
  enqueued: number;
  skipped: number;
}

/**
 * One enqueue round: per spec target, skip if the bucket key exists (any status), else enqueue.
 * A failing target is only logged and does not affect the others.
 */
export async function runPeriodicEnqueue(
  db: Db,
  specs: PeriodicSpec[],
  opts: { now?: number; log?: (message: string, data?: Record<string, unknown>) => void } = {},
): Promise<PeriodicRunResult> {
  const now = opts.now ?? Date.now();
  let enqueued = 0;
  let skipped = 0;

  for (const spec of specs) {
    if (spec.everyMs <= 0) continue; // disabled
    const bucket = periodBucket(now, spec.everyMs);
    let targets: PeriodicTarget[];
    try {
      targets = await spec.targets(db);
    } catch (error) {
      opts.log?.('周期入队目标解析失败', { type: spec.type, error: (error as Error).message });
      continue;
    }
    for (const t of targets) {
      const dedupeKey = `${spec.type}:${t.key}:${bucket}`;
      try {
        const inserted = await db.transaction().execute(async (trx) => {
          await sql`select pg_advisory_xact_lock(hashtextextended(${dedupeKey}, 0))`.execute(trx);
          const existing = await trx
            .selectFrom('jobs')
            .select('id')
            .where('tenant_id', '=', t.tenantId)
            .where('dedupe_key', '=', dedupeKey)
            .executeTakeFirst();
          if (existing) return false;
          await enqueueJob(trx, {
            tenantId: t.tenantId,
            type: spec.type as never,
            payload: t.payload,
            dedupeKey,
          });
          return true;
        });
        if (!inserted) {
          skipped += 1;
          continue;
        }
        enqueued += 1;
      } catch (error) {
        opts.log?.('周期入队失败', {
          type: spec.type,
          key: t.key,
          error: (error as Error).message,
        });
      }
    }
  }
  return { enqueued, skipped };
}
