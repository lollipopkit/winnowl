import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { sql } from 'kysely';

export type WorkerMode = 'active' | 'draining' | 'offline';

/** Reused by (tenant, name): a pool names a class of runners, not one process start. */
export async function ensureRunnerPool(
  db: Db,
  input: { tenantId?: string | null; name: string },
): Promise<string> {
  const tenantId = input.tenantId ?? null;
  const id = uuidv7();
  const inserted = await db
    .insertInto('runner_pools')
    .values({ id, tenant_id: tenantId, name: input.name, created_at: new Date() })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return inserted.id;

  let q = db.selectFrom('runner_pools').select('id').where('name', '=', input.name);
  q = tenantId === null ? q.where('tenant_id', 'is', null) : q.where('tenant_id', '=', tenantId);
  const existing = await q.executeTakeFirst();
  if (!existing)
    throw new Error(`runner pool insert conflicted without a matching identity: ${input.name}`);
  return existing.id;
}

/** Worker rows describe live processes; deletes rows whose heartbeat stopped long ago (default 1 day). */
export async function pruneDeadWorkers(db: Db, olderThanMs = 86_400_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const res = await db
    .deleteFrom('workers')
    .where('last_heartbeat_at', '<', cutoff)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0n);
}

/**
 * Workers with a heartbeat within `withinMs`, used to find orphaned sandbox containers.
 * Heartbeat is 15s, default window 90s; a wider window would count a just-replaced process as alive.
 */
export async function listLiveWorkerIds(db: Db, withinMs = 90_000): Promise<Set<string>> {
  const rows = await db
    .selectFrom('workers')
    .select('id')
    .where('last_heartbeat_at', '>=', new Date(Date.now() - withinMs))
    .execute();
  return new Set(rows.map((r) => r.id));
}

export async function registerWorker(
  db: Db,
  input: {
    poolId: string;
    version: string;
    capabilities?: Record<string, unknown>;
    maxConcurrency?: number;
  },
): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('workers')
    .values({
      id,
      pool_id: input.poolId,
      mode: 'active',
      version: input.version,
      capabilities: input.capabilities ?? {},
      max_concurrency: input.maxConcurrency ?? 1,
      running_jobs: 0,
      last_heartbeat_at: new Date(),
      registered_at: new Date(),
    })
    .execute();
  return id;
}

export async function heartbeatWorker(db: Db, workerId: string): Promise<void> {
  await db
    .updateTable('workers')
    .set({ last_heartbeat_at: new Date() })
    .where('id', '=', workerId)
    .execute();
}

/** A draining worker can no longer claim jobs. */
export async function setWorkerMode(db: Db, workerId: string, mode: WorkerMode): Promise<void> {
  await db.updateTable('workers').set({ mode }).where('id', '=', workerId).execute();
}

export async function countRunningJobs(db: Db, workerId: string): Promise<number> {
  const row = await db
    .selectFrom('jobs')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('lease_owner', '=', workerId)
    .where('status', 'in', ['leased', 'running'])
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function isSafeToTerminate(db: Db, workerId: string): Promise<boolean> {
  const result = await sql<{ safe: boolean }>`
    select exists(
      select 1 from workers where id = ${workerId}::uuid and mode <> 'active'
    ) and not exists(
      select 1 from jobs
      where lease_owner = ${workerId}::uuid and status in ('leased', 'running')
    ) as safe
  `.execute(db);
  return result.rows[0]?.safe ?? false;
}
