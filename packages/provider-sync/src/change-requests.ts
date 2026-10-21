import { sql, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';

/**
 * What the forge reported about a change request at one moment, from a webhook or read through its API.
 * Absent fields are unknown and leave the stored value alone.
 */
export interface ChangeRequestSnapshot {
  nativeId: string;
  number: number;
  kind: 'pull-request' | 'merge-request';
  /** When the forge reported this; an older snapshot never overwrites newer state. */
  observedAt: Date;
  state?: 'open' | 'closed' | 'merged';
  /** A reopen ranks with closed at equal timestamps, so close+reopen in one second ends open. */
  reopened?: boolean;
  draft?: boolean;
  sourceBranch?: string;
  targetBranch?: string;
  sourceIsFork?: boolean;
  title?: string;
  author?: { login: string; providerUserId?: string; type?: string };
  reviewers?: { providerUserId: string; login: string }[];
  labels?: string[];
  /** GitHub's native stack info, where available. */
  stack?: { baseRef?: string; position?: number; size?: number };
}

export interface RevisionSnapshot {
  baseSha: string;
  headSha: string;
  sourceBranch?: string;
  targetBranch?: string;
}

/**
 * Finds the parent of a stacked CR by branch topology: an open CR whose source branch is our target branch.
 * The parent must be a same-repo branch (`source_is_fork = false`); a fork's `main` would otherwise parent every PR into `main`.
 * null if none (or not registered yet; the next updated event retries).
 */
async function resolveStackedOn(
  db: Db,
  repositoryId: string,
  targetBranch: string,
  selfNativeId: string,
): Promise<string | null> {
  const parent = await db
    .selectFrom('change_requests')
    .select(['id'])
    .where('repository_id', '=', repositoryId)
    .where('source_branch', '=', targetBranch)
    .where('state', '=', 'open')
    .where('source_is_fork', '=', false)
    .where('native_id', '!=', selfNativeId) // never self-reference
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return parent?.id ?? null;
}

const stateRankOf = (value: string): number => {
  switch (value) {
    case 'merged':
      return 3;
    case 'closed':
      return 2;
    default:
      return 1;
  }
};

/**
 * Upsert by (repository, native id), newest snapshot wins per field. `applied` is false when a newer state
 * was already stored, so lifecycle side effects (revisions, reviews) must not follow.
 */
export async function upsertChangeRequest(
  db: Db,
  scope: { tenantId: string; repositoryId: string },
  snap: ChangeRequestSnapshot,
  now: Date,
): Promise<{ id: string; applied: boolean }> {
  const { state } = snap;
  const eventAt = snap.observedAt;
  const previousEventAt = sql`coalesce(change_requests.last_provider_event_at, '-infinity'::timestamptz)`;
  // Provider timestamps have second precision, so ties are decided by state rank; merged stays terminal.
  const eventRank = state === undefined ? undefined : snap.reopened ? 2 : stateRankOf(state);
  const tieAllowed =
    eventRank === undefined
      ? sql<boolean>`true`
      : sql<boolean>`${eventRank} >= case change_requests.state when 'merged' then 3 when 'closed' then 2 else 1 end`;
  const isNewest = sql<boolean>`
    excluded.last_provider_event_at > ${previousEventAt}
    or (excluded.last_provider_event_at = ${previousEventAt} and ${tieAllowed})
  `;
  const newest = <T>(column: string) =>
    sql<T>`case when ${isNewest} then ${sql.ref(`excluded.${column}`)} else ${sql.ref(`change_requests.${column}`)} end`;

  const author = snap.author?.login;
  // Stable numeric id; logins can be renamed or recycled.
  const authorProviderId = snap.author?.providerUserId;
  // Record what the forge says (`[bot]` is only a GitHub naming convention). Unknown stays undefined so the
  // gate falls back to the suffix heuristic; a known human is stored as false.
  const authorIsBot = snap.author?.type !== undefined ? snap.author.type === 'bot' : undefined;
  const reviewers = snap.reviewers !== undefined ? JSON.stringify(snap.reviewers) : undefined;
  const labels = snap.labels !== undefined ? JSON.stringify(snap.labels) : undefined;
  // Stack parent by branch topology covers forges without native stacks; recomputed to follow retargets.
  const stackedOn =
    snap.targetBranch !== undefined
      ? await resolveStackedOn(db, scope.repositoryId, snap.targetBranch, snap.nativeId)
      : undefined;
  const { stack, sourceBranch, targetBranch, sourceIsFork, title, draft } = snap;

  const row = await db
    .insertInto('change_requests')
    .values({
      id: uuidv7(now.getTime()),
      tenant_id: scope.tenantId,
      repository_id: scope.repositoryId,
      native_id: snap.nativeId,
      number: snap.number,
      kind: snap.kind,
      source_branch: sourceBranch ?? null,
      source_is_fork: sourceIsFork ?? null,
      title: title ?? null,
      target_branch: targetBranch ?? null,
      state: state ?? 'open',
      draft: draft ?? false,
      author: author ?? null,
      author_provider_id: authorProviderId ?? null,
      author_is_bot: authorIsBot ?? null,
      ...(reviewers !== undefined ? { reviewers } : {}),
      ...(labels !== undefined ? { labels } : {}),
      ...(stackedOn !== undefined ? { stacked_on_change_request_id: stackedOn } : {}),
      ...(stack?.baseRef !== undefined ? { stack_base_ref: stack.baseRef } : {}),
      ...(stack?.position !== undefined ? { stack_position: stack.position } : {}),
      ...(stack?.size !== undefined ? { stack_size: stack.size } : {}),
      last_provider_event_at: eventAt,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['repository_id', 'native_id']).doUpdateSet({
        number: snap.number,
        kind: snap.kind,
        updated_at: now,
        last_provider_event_at: sql`greatest(change_requests.last_provider_event_at, excluded.last_provider_event_at)`,
        ...(state !== undefined ? { state: newest<string>('state') } : {}),
        ...(sourceBranch !== undefined
          ? { source_branch: newest<string | null>('source_branch') }
          : {}),
        ...(targetBranch !== undefined
          ? { target_branch: newest<string | null>('target_branch') }
          : {}),
        ...(sourceIsFork !== undefined
          ? { source_is_fork: newest<boolean | null>('source_is_fork') }
          : {}),
        ...(title !== undefined ? { title: newest<string | null>('title') } : {}),
        ...(draft !== undefined ? { draft: newest<boolean>('draft') } : {}),
        // Author fields never change, so coalesce rather than newest-wins: a late (older) opened can still fill them.
        ...(author !== undefined
          ? { author: sql<string | null>`coalesce(change_requests.author, excluded.author)` }
          : {}),
        ...(authorProviderId !== undefined
          ? {
              author_provider_id: sql<
                string | null
              >`coalesce(change_requests.author_provider_id, excluded.author_provider_id)`,
            }
          : {}),
        ...(authorIsBot !== undefined
          ? {
              author_is_bot: sql<
                boolean | null
              >`coalesce(change_requests.author_is_bot, excluded.author_is_bot)`,
            }
          : {}),
        ...(reviewers !== undefined ? { reviewers: newest<string>('reviewers') } : {}),
        ...(labels !== undefined ? { labels: newest<string>('labels') } : {}),
        ...(stackedOn !== undefined
          ? {
              stacked_on_change_request_id: newest<string | null>('stacked_on_change_request_id'),
            }
          : {}),
        ...(stack?.baseRef !== undefined
          ? { stack_base_ref: newest<string | null>('stack_base_ref') }
          : {}),
        ...(stack?.position !== undefined
          ? { stack_position: newest<number | null>('stack_position') }
          : {}),
        ...(stack?.size !== undefined ? { stack_size: newest<number | null>('stack_size') } : {}),
      }),
    )
    .returning(['id', 'state', 'last_provider_event_at'])
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    applied:
      row.last_provider_event_at.getTime() <= eventAt.getTime() &&
      (state === undefined || row.state === state),
  };
}

/** Idempotent on (change request, head sha). */
export async function insertRevision(
  db: Db,
  scope: { tenantId: string; changeRequestId: string },
  rev: RevisionSnapshot,
  now: Date,
): Promise<{ id: string; inserted: boolean } | null> {
  const inserted = await db
    .insertInto('revisions')
    .values({
      id: uuidv7(now.getTime()),
      tenant_id: scope.tenantId,
      change_request_id: scope.changeRequestId,
      base_sha: rev.baseSha,
      head_sha: rev.headSha,
      merge_base_sha: null,
      source_branch: rev.sourceBranch ?? null,
      target_branch: rev.targetBranch ?? null,
      created_at: now,
    })
    .onConflict((oc) => oc.columns(['change_request_id', 'head_sha']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted) return { id: inserted.id, inserted: true };
  const existing = await db
    .selectFrom('revisions')
    .select('id')
    .where('change_request_id', '=', scope.changeRequestId)
    .where('head_sha', '=', rev.headSha)
    .executeTakeFirst();
  return existing ? { id: existing.id, inserted: false } : null;
}
