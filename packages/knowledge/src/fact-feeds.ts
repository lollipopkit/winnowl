import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { FactEcosystem } from './fact-ecosystems.js';

/** An operator-registered page (release notes, breaking changes) that facts are extracted from. */
export interface FactFeed {
  id: string;
  ecosystem: FactEcosystem;
  subject: string;
  url: string;
  label?: string;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  lastFetchedAt?: Date;
  lastContentHash?: string;
  lastError?: string;
  lastProposed: number;
  lastCostUsd?: number;
}

/** How often a feed is re-read. */
export const FACT_FEED_REFRESH_MS = 7 * 86_400_000;

type FeedRow = {
  id: string;
  ecosystem: string;
  subject: string;
  url: string;
  label: string | null;
  enabled: boolean;
  created_by: string;
  created_at: Date;
  last_fetched_at: Date | null;
  last_content_hash: string | null;
  last_error: string | null;
  last_proposed: number;
  last_cost_usd: string | number | null;
};

function rowToFeed(r: FeedRow): FactFeed {
  return {
    id: r.id,
    ecosystem: r.ecosystem as FactEcosystem,
    subject: r.subject,
    url: r.url,
    ...(r.label ? { label: r.label } : {}),
    enabled: r.enabled,
    createdBy: r.created_by,
    createdAt: r.created_at,
    ...(r.last_fetched_at ? { lastFetchedAt: r.last_fetched_at } : {}),
    ...(r.last_content_hash ? { lastContentHash: r.last_content_hash } : {}),
    ...(r.last_error ? { lastError: r.last_error } : {}),
    lastProposed: r.last_proposed,
    ...(r.last_cost_usd !== null ? { lastCostUsd: Number(r.last_cost_usd) } : {}),
  };
}

export async function listFactFeeds(db: Db): Promise<FactFeed[]> {
  const rows = await db.selectFrom('ecosystem_fact_feeds').selectAll().orderBy('created_at', 'desc').execute();
  return rows.map(rowToFeed);
}

export async function insertFactFeed(
  db: Db,
  input: { ecosystem: FactEcosystem; subject: string; url: string; label?: string; createdBy: string },
): Promise<FactFeed> {
  const row = await db
    .insertInto('ecosystem_fact_feeds')
    .values({
      id: uuidv7(),
      ecosystem: input.ecosystem,
      subject: input.subject.trim().slice(0, 120),
      url: input.url.trim(),
      label: input.label?.trim().slice(0, 120) || null,
      enabled: true,
      created_by: input.createdBy,
      created_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return rowToFeed(row);
}

/** Enable / disable; `refresh` makes it due on the next tick. Unknown id → false. */
export async function updateFactFeed(
  db: Db,
  id: string,
  change: { enabled?: boolean; refresh?: boolean },
): Promise<boolean> {
  const res = await db
    .updateTable('ecosystem_fact_feeds')
    .set({
      ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
      ...(change.refresh ? { last_fetched_at: null, last_content_hash: null } : {}),
    })
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0n) > 0;
}

export async function deleteFactFeed(db: Db, id: string): Promise<boolean> {
  const res = await db.deleteFrom('ecosystem_fact_feeds').where('id', '=', id).executeTakeFirst();
  return Number(res.numDeletedRows ?? 0n) > 0;
}

/** Enabled feeds never fetched or last fetched before `now - FACT_FEED_REFRESH_MS`, oldest first. */
export async function dueFactFeeds(db: Db, now: number = Date.now(), limit = 5): Promise<FactFeed[]> {
  const cutoff = new Date(now - FACT_FEED_REFRESH_MS);
  const rows = await db
    .selectFrom('ecosystem_fact_feeds')
    .selectAll()
    .where('enabled', '=', true)
    .where((eb) => eb.or([eb('last_fetched_at', 'is', null), eb('last_fetched_at', '<', cutoff)]))
    .execute();
  // Never-fetched first, then the stalest (the table is a handful of operator-managed rows).
  const at = (r: FeedRow): number => (r.last_fetched_at ? new Date(r.last_fetched_at).getTime() : -Infinity);
  return rows
    .sort((a, b) => at(a) - at(b))
    .slice(0, limit)
    .map(rowToFeed);
}

/** Record one refresh. `proposed`/`costUsd` only when the content changed and was processed. */
export async function recordFactFeedRun(
  db: Db,
  id: string,
  run: { contentHash?: string; error?: string; proposed?: number; costUsd?: number; at?: Date },
): Promise<void> {
  await db
    .updateTable('ecosystem_fact_feeds')
    .set({
      last_fetched_at: run.at ?? new Date(),
      last_error: run.error ? run.error.slice(0, 1000) : null,
      ...(run.contentHash !== undefined ? { last_content_hash: run.contentHash } : {}),
      ...(run.proposed !== undefined ? { last_proposed: run.proposed } : {}),
      ...(run.costUsd !== undefined ? { last_cost_usd: run.costUsd.toFixed(6) } : {}),
    })
    .where('id', '=', id)
    .execute();
}
