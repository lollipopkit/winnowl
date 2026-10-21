import { sql, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';

/** Standard RLS: every read/write runs in the owning tenant's context; no cross-tenant writes. */

export type NotificationKind =
  'cross-tenant-contract-change' | 'security-finding' | 'quota-warning' | 'review-completed';

export interface Notification {
  id: string;
  tenantId: string;
  kind: string;
  title: string;
  body: string;
  link?: string;
  payload: Record<string, unknown>;
  readAt?: string;
  emailedAt?: string;
  createdAt: string;
}

export interface CreateNotificationInput {
  tenantId: string;
  kind: NotificationKind | string;
  title: string;
  body?: string;
  link?: string;
  payload?: Record<string, unknown>;
  /** Stored as payload.dedupeKey; periodic intake rescans the same sources, so this prevents duplicates. */
  dedupeKey?: string;
  now?: Date;
}

interface Row {
  id: string;
  tenant_id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  payload: Record<string, unknown>;
  read_at: Date | null;
  emailed_at: Date | null;
  email_claim_token: string | null;
  email_claim_expires_at: Date | null;
  created_at: Date;
}

function mapRow(r: Row): Notification {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    ...(r.link ? { link: r.link } : {}),
    payload: r.payload ?? {},
    ...(r.read_at ? { readAt: new Date(r.read_at).toISOString() } : {}),
    ...(r.emailed_at ? { emailedAt: new Date(r.emailed_at).toISOString() } : {}),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** Returns the existing row on a `dedupeKey` hit. */
export async function createNotification(
  db: Db,
  input: CreateNotificationInput,
): Promise<Notification> {
  if (input.dedupeKey) {
    const existing = await db
      .selectFrom('notifications')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where((eb) => eb(eb.ref('payload', '->>').key('dedupeKey'), '=', input.dedupeKey!))
      .executeTakeFirst();
    if (existing) return mapRow(existing as unknown as Row);
  }
  const id = uuidv7();
  const now = input.now ?? new Date();
  const payload = {
    ...(input.payload ?? {}),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
  };
  const inserted = await db
    .insertInto('notifications')
    .values({
      id,
      tenant_id: input.tenantId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? '',
      link: input.link ?? null,
      payload,
      read_at: null,
      emailed_at: null,
      email_claim_token: null,
      email_claim_expires_at: null,
      created_at: now,
    })
    // A unique expression index collapses concurrent inserts of the same tenant/dedupeKey.
    .onConflict((oc) => oc.doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return mapRow(inserted as unknown as Row);
  if (input.dedupeKey) {
    const existing = await db
      .selectFrom('notifications')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where((eb) => eb(eb.ref('payload', '->>').key('dedupeKey'), '=', input.dedupeKey!))
      .executeTakeFirst();
    if (existing) return mapRow(existing as unknown as Row);
  }
  throw new Error('notification insert conflicted without a matching dedupe key');
}

export interface ListNotificationsOptions {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
}

export async function listNotifications(
  db: Db,
  tenantId: string,
  opts: ListNotificationsOptions = {},
): Promise<{ items: Notification[]; total: number; unread: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  let q = db.selectFrom('notifications').selectAll().where('tenant_id', '=', tenantId);
  if (opts.unreadOnly) q = q.where('read_at', 'is', null);
  const rows = (await q
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()) as unknown as Row[];

  const totalRow = await (
    opts.unreadOnly
      ? db
          .selectFrom('notifications')
          .select(db.fn.countAll().as('n'))
          .where('tenant_id', '=', tenantId)
          .where('read_at', 'is', null)
      : db
          .selectFrom('notifications')
          .select(db.fn.countAll().as('n'))
          .where('tenant_id', '=', tenantId)
  ).executeTakeFirst();
  const unreadRow = await db
    .selectFrom('notifications')
    .select(db.fn.countAll().as('n'))
    .where('tenant_id', '=', tenantId)
    .where('read_at', 'is', null)
    .executeTakeFirst();

  return {
    items: rows.map(mapRow),
    total: Number(totalRow?.n ?? 0),
    unread: Number(unreadRow?.n ?? 0),
  };
}

/** Idempotent; false when missing or owned by another tenant. */
export async function markNotificationRead(
  db: Db,
  tenantId: string,
  id: string,
  now = new Date(),
): Promise<boolean> {
  const res = await db
    .updateTable('notifications')
    .set({ read_at: now })
    .where('id', '=', id)
    .where('tenant_id', '=', tenantId)
    .where('read_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export async function markAllNotificationsRead(
  db: Db,
  tenantId: string,
  now = new Date(),
): Promise<number> {
  const res = await db
    .updateTable('notifications')
    .set({ read_at: now })
    .where('tenant_id', '=', tenantId)
    .where('read_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/** Call only within the owning tenant's context. */
export async function pendingEmailNotifications(
  db: Db,
  tenantId: string,
  limit = 50,
): Promise<Notification[]> {
  const rows = (await db
    .selectFrom('notifications')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('emailed_at', 'is', null)
    .orderBy('created_at')
    .limit(limit)
    .execute()) as unknown as Row[];
  return rows.map(mapRow);
}

/** SKIP LOCKED gives concurrent workers disjoint batches. */
export async function claimPendingEmailNotifications(
  db: Db,
  tenantId: string,
  claimToken: string,
  limit = 50,
  leaseSeconds = 3600,
): Promise<Notification[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const boundedLease = Math.min(Math.max(leaseSeconds, 60), 24 * 60 * 60);
  const result = await sql<Row>`
    with candidates as (
      select id
      from notifications
      where tenant_id = ${tenantId}::uuid
        and emailed_at is null
        and (email_claim_token is null or email_claim_expires_at < now())
      order by created_at
      limit ${boundedLimit}
      for update skip locked
    )
    update notifications as notification
    set email_claim_token = ${claimToken}::uuid,
        email_claim_expires_at = now() + (${boundedLease} * interval '1 second')
    from candidates
    where notification.id = candidates.id
    returning notification.*
  `.execute(db);
  return result.rows.map(mapRow);
}

/** Must match both the tenant and this claim. */
export async function markNotificationEmailed(
  db: Db,
  tenantId: string,
  id: string,
  claimToken: string,
  now = new Date(),
): Promise<boolean> {
  const result = await db
    .updateTable('notifications')
    .set({ emailed_at: now, email_claim_token: null, email_claim_expires_at: null })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .where('emailed_at', 'is', null)
    .where('email_claim_token', '=', claimToken)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Keeps another worker from reclaiming the row during a slow SMTP call. */
export async function renewNotificationEmailClaim(
  db: Db,
  tenantId: string,
  id: string,
  claimToken: string,
  leaseSeconds = 3600,
): Promise<boolean> {
  const boundedLease = Math.min(Math.max(leaseSeconds, 60), 24 * 60 * 60);
  const result = await db
    .updateTable('notifications')
    .set({ email_claim_expires_at: sql`now() + (${boundedLease} * interval '1 second')` })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .where('emailed_at', 'is', null)
    .where('email_claim_token', '=', claimToken)
    .where('email_claim_expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function releaseNotificationEmailClaim(
  db: Db,
  tenantId: string,
  id: string,
  claimToken: string,
): Promise<boolean> {
  const result = await db
    .updateTable('notifications')
    .set({ email_claim_token: null, email_claim_expires_at: null })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', id)
    .where('emailed_at', 'is', null)
    .where('email_claim_token', '=', claimToken)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function notificationRecipients(
  db: Db,
  tenantId: string,
  minRoles: string[] = ['owner', 'admin'],
): Promise<string[]> {
  const rows = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select('users.email as email')
    .where('memberships.tenant_id', '=', tenantId)
    .where('memberships.status', '=', 'active')
    .where('memberships.role', 'in', minRoles)
    .execute();
  // JIT-provisioned provider users have undeliverable `...@provider.local` placeholder emails.
  return rows
    .map((r) => r.email)
    .filter((e): e is string => Boolean(e) && !e.endsWith('@provider.local'));
}
