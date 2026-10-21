import { runWithoutTenant, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';

/**
 * Source proposes, target approves. Neither side reads the other's code: the target's own runner
 * opens issues in its own context. RLS only controls visibility, so writes and state transitions
 * must check explicitly which side the caller is on.
 */

export type CrossTenantStatus = 'proposed' | 'active' | 'rejected' | 'revoked';

export interface CrossTenantRelationship {
  id: string;
  sourceTenantId: string;
  sourceRepositoryId: string;
  targetTenantId: string;
  targetRepositoryId: string;
  kind: string;
  status: CrossTenantStatus;
  proposedBy?: string;
  decidedBy?: string;
  rationale?: string;
}

interface Row {
  id: string;
  source_tenant_id: string;
  source_repository_id: string;
  target_tenant_id: string;
  target_repository_id: string;
  kind: string;
  status: string;
  proposed_by: string | null;
  decided_by: string | null;
  rationale: string | null;
}

function mapRow(r: Row): CrossTenantRelationship {
  return {
    id: r.id,
    sourceTenantId: r.source_tenant_id,
    sourceRepositoryId: r.source_repository_id,
    targetTenantId: r.target_tenant_id,
    targetRepositoryId: r.target_repository_id,
    kind: r.kind,
    status: r.status as CrossTenantStatus,
    ...(r.proposed_by ? { proposedBy: r.proposed_by } : {}),
    ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
    ...(r.rationale ? { rationale: r.rationale } : {}),
  };
}

export interface ProposeCrossTenantInput {
  sourceTenantId: string;
  sourceRepositoryId: string;
  targetTenantId: string;
  targetRepositoryId: string;
  kind: string;
  proposedBy?: string;
  rationale?: string;
}

/**
 * Existing (source, target, kind): `rejected`/`revoked` reset to proposed; `proposed`/`active` are
 * returned unchanged so the other side's decision is never reset.
 */
export async function proposeCrossTenantRelationship(
  db: Db,
  input: ProposeCrossTenantInput,
): Promise<CrossTenantRelationship> {
  if (input.sourceTenantId === input.targetTenantId) {
    throw new Error('同租户关系应走 repository_relationships,不进跨租户表');
  }
  /*
   * Deliberately cross-tenant for the whole transaction: the other repository is invisible under
   * RLS, and the scoping driver sets `app.tenant_id` before this callback runs, so it cannot be
   * scoped tighter. Authorization does not rely on visibility: source is the caller's own tenant,
   * target comes from the HMAC-signed invite, and composite FKs re-check both on insert.
   */
  return runWithoutTenant(() =>
    db.transaction().execute(async (trx) => {
      const repositories = await trx
        .selectFrom('repositories')
        .select(['id', 'tenant_id'])
        .where('id', 'in', [input.sourceRepositoryId, input.targetRepositoryId])
        .execute();
      const source = repositories.find((row) => row.id === input.sourceRepositoryId);
      const target = repositories.find((row) => row.id === input.targetRepositoryId);
      if (source?.tenant_id !== input.sourceTenantId || target?.tenant_id !== input.targetTenantId) {
        throw new Error('跨租户关系的 repository/tenant 绑定无效');
      }

      const id = uuidv7();
      const now = new Date();
      const inserted = await trx
        .insertInto('cross_tenant_relationships')
        .values({
          id,
          source_tenant_id: input.sourceTenantId,
          source_repository_id: input.sourceRepositoryId,
          target_tenant_id: input.targetTenantId,
          target_repository_id: input.targetRepositoryId,
          kind: input.kind,
          status: 'proposed',
          proposed_by: input.proposedBy ?? null,
          decided_by: null,
          rationale: input.rationale ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['source_repository_id', 'target_repository_id', 'kind']).doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      if (inserted) return mapRow(inserted as unknown as Row);

      const existing = await trx
        .selectFrom('cross_tenant_relationships')
        .selectAll()
        .where('source_repository_id', '=', input.sourceRepositoryId)
        .where('target_repository_id', '=', input.targetRepositoryId)
        .where('kind', '=', input.kind)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (existing.status === 'proposed' || existing.status === 'active')
        return mapRow(existing as unknown as Row);
      const reset = await trx
        .updateTable('cross_tenant_relationships')
        .set({
          status: 'proposed',
          proposed_by: input.proposedBy ?? null,
          decided_by: null,
          rationale: input.rationale ?? null,
          updated_at: now,
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return mapRow(reset as unknown as Row);
    }),
  );
}

export type CrossTenantDecision = 'approve' | 'reject' | 'revoke';

/**
 * `approve`/`reject`: target tenant only. `revoke`: either side. Unauthorized or invalid transition
 * -> null (RLS controls visibility, not write rights).
 */
export async function decideCrossTenantRelationship(
  db: Db,
  input: { id: string; actingTenantId: string; decision: CrossTenantDecision; decidedBy?: string },
): Promise<CrossTenantRelationship | null> {
  let next: CrossTenantStatus;
  let update = db
    .updateTable('cross_tenant_relationships')
    .set({ decided_by: input.decidedBy ?? null, updated_at: new Date() })
    .where('id', '=', input.id);
  if (input.decision === 'approve' || input.decision === 'reject') {
    next = input.decision === 'approve' ? 'active' : 'rejected';
    update = update
      .where('target_tenant_id', '=', input.actingTenantId)
      .where('status', '=', 'proposed');
  } else {
    next = 'revoked';
    update = update
      .where((eb) =>
        eb.or([
          eb('source_tenant_id', '=', input.actingTenantId),
          eb('target_tenant_id', '=', input.actingTenantId),
        ]),
      )
      .where('status', 'in', ['active', 'proposed']);
  }
  const row = await update.set({ status: next }).returningAll().executeTakeFirst();
  return row ? mapRow(row as unknown as Row) : null;
}

/** Active relationships where this repository is upstream. */
export async function loadActiveCrossTenantForSource(
  db: Db,
  sourceRepositoryId: string,
): Promise<CrossTenantRelationship[]> {
  const rows = (await db
    .selectFrom('cross_tenant_relationships')
    .selectAll()
    .where('source_repository_id', '=', sourceRepositoryId)
    .where('status', '=', 'active')
    .execute()) as unknown as Row[];
  return rows.map(mapRow);
}

/** Explicit tenant predicate: without a tenant context the RLS policy is permissive and would return every tenant's rows. */
export async function listCrossTenantRelationships(
  db: Db,
  tenantId: string,
  opts: { status?: CrossTenantStatus } = {},
): Promise<CrossTenantRelationship[]> {
  let q = db
    .selectFrom('cross_tenant_relationships')
    .selectAll()
    .where((eb) =>
      eb.or([eb('source_tenant_id', '=', tenantId), eb('target_tenant_id', '=', tenantId)]),
    )
    .orderBy('created_at', 'desc');
  if (opts.status) q = q.where('status', '=', opts.status);
  return ((await q.execute()) as unknown as Row[]).map(mapRow);
}

/**
 * Visible to both sides: upstream INSERTs in its own context (WITH CHECK on source), downstream
 * SELECTs/UPDATEs in its own (USING on target), so no tenant switching is needed.
 */
export interface CrossTenantEvent {
  id: string;
  relationshipId: string;
  sourceTenantId: string;
  sourceRepositoryId: string;
  targetTenantId: string;
  targetRepositoryId: string;
  kind: string;
  payload: Record<string, unknown>;
}

function safeCrossTenantPayload(
  payload: Record<string, unknown>,
  sourceRevisionId: string,
): Record<string, unknown> {
  if (!sourceRevisionId || sourceRevisionId.length > 200)
    throw new Error('sourceRevisionId must be between 1 and 200 characters');
  const rawPaths = payload.contractPaths;
  const contractPaths = Array.isArray(rawPaths)
    ? [
        ...new Set(
          rawPaths
            .filter((path): path is string => typeof path === 'string')
            .map((path) => path.trim())
            .filter((path) => path.length > 0 && path.length <= 512),
        ),
      ].slice(0, 100)
    : [];
  return { sourceRevisionId, contractPaths };
}

/** Unique on (relationship_id, payload->>'sourceRevisionId'): one event per upstream revision. */
export async function recordCrossTenantEvent(
  db: Db,
  input: Omit<CrossTenantEvent, 'id'> & { sourceRevisionId: string },
): Promise<string | null> {
  try {
    return await db.transaction().execute(async (trx) => {
      /*
       * Source side only: under `runWithTenant(source)` the target's rows are invisible, so a join on
       * the target repository would always fail. The target binding is enforced by FKs
       * (`cross_tenant_relationships_target_repository_fk`,
       * `cross_tenant_events_relationship_coordinates_fk`), whose checks bypass RLS.
       */
      const relationship = await trx
        .selectFrom('cross_tenant_relationships as rel')
        .select('rel.id')
        .where('rel.id', '=', input.relationshipId)
        .where('rel.status', '=', 'active')
        .where('rel.source_tenant_id', '=', input.sourceTenantId)
        .where('rel.source_repository_id', '=', input.sourceRepositoryId)
        .where('rel.target_tenant_id', '=', input.targetTenantId)
        .where('rel.target_repository_id', '=', input.targetRepositoryId)
        .forShare()
        .executeTakeFirst();
      if (!relationship) throw new Error('cross-tenant event does not match an active relationship');

      const id = uuidv7();
      const payload = safeCrossTenantPayload(input.payload, input.sourceRevisionId);
      await trx
        .insertInto('cross_tenant_events')
        .values({
          id,
          relationship_id: input.relationshipId,
          source_tenant_id: input.sourceTenantId,
          source_repository_id: input.sourceRepositoryId,
          target_tenant_id: input.targetTenantId,
          target_repository_id: input.targetRepositoryId,
          kind: input.kind,
          payload,
          consumed_at: null,
          attempt_count: 0,
          last_error: null,
          next_attempt_at: null,
          failed_at: null,
          created_at: new Date(),
        })
        .execute();
      return id;
    });
  } catch (error) {
    // Unique violation: already recorded for this revision.
    if (
      (error as { code?: string; cause?: { code?: string } })?.code === '23505' ||
      (error as { cause?: { code?: string } })?.cause?.code === '23505'
    ) {
      return null;
    }
    throw error;
  }
}

/** Excludes consumed, failed and still-backing-off events. */
export async function pendingCrossTenantEvents(
  db: Db,
  targetTenantId: string,
  limit = 50,
  now = new Date(),
): Promise<CrossTenantEvent[]> {
  const rows = await db
    .selectFrom('cross_tenant_events as event')
    .innerJoin('cross_tenant_relationships as relationship', (join) =>
      join
        .onRef('relationship.id', '=', 'event.relationship_id')
        .on('relationship.status', '=', 'active')
        .onRef('relationship.source_tenant_id', '=', 'event.source_tenant_id')
        .onRef('relationship.source_repository_id', '=', 'event.source_repository_id')
        .onRef('relationship.target_tenant_id', '=', 'event.target_tenant_id')
        .onRef('relationship.target_repository_id', '=', 'event.target_repository_id'),
    )
    .selectAll('event')
    .where('event.target_tenant_id', '=', targetTenantId)
    .where('event.consumed_at', 'is', null)
    .where('event.failed_at', 'is', null)
    .where((eb) =>
      eb.or([eb('event.next_attempt_at', 'is', null), eb('event.next_attempt_at', '<=', now)]),
    )
    .orderBy('event.created_at')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    relationshipId: r.relationship_id,
    sourceTenantId: r.source_tenant_id,
    sourceRepositoryId: r.source_repository_id,
    targetTenantId: r.target_tenant_id,
    targetRepositoryId: r.target_repository_id,
    kind: r.kind,
    payload: safeCrossTenantPayload(
      (r.payload ?? {}) as Record<string, unknown>,
      String(((r.payload ?? {}) as Record<string, unknown>).sourceRevisionId ?? ''),
    ),
  }));
}

/** Target tenant only; failed events cannot be consumed. */
export async function markCrossTenantEventConsumed(
  db: Db,
  id: string,
  targetTenantId: string,
  now = new Date(),
): Promise<boolean> {
  const res = await db
    .updateTable('cross_tenant_events')
    .set({ consumed_at: now })
    .where('id', '=', id)
    .where('target_tenant_id', '=', targetTenantId)
    .where('consumed_at', 'is', null)
    .where('failed_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

/** Delivery runs on a periodic job (default every 5 minutes), so backoff is in rounds. */
export const CROSS_TENANT_EVENT_MAX_ATTEMPTS = 5;
/** 1 -> 5 min, 2 -> 10 min, ... capped at 30 min. */
function crossTenantEventBackoffMs(attempts: number): number {
  return Math.min(attempts, 6) * 5 * 60_000;
}

/**
 * Per-event retry state so one stuck delivery does not block the others. Past the threshold sets
 * `failed_at` (terminal); the caller notifies the tenant. null when consumed, failed or not ours.
 */
export async function failCrossTenantEvent(
  db: Db,
  id: string,
  targetTenantId: string,
  error: unknown,
  opts: { now?: Date; maxAttempts?: number } = {},
): Promise<{ attempts: number; failed: boolean } | null> {
  const now = opts.now ?? new Date();
  const maxAttempts = opts.maxAttempts ?? CROSS_TENANT_EVENT_MAX_ATTEMPTS;
  const detail = {
    message: error instanceof Error ? error.message : String(error),
    at: now.toISOString(),
  };
  // for update: concurrent intake runs count each failure once.
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('cross_tenant_events')
      .select(['attempt_count'])
      .where('id', '=', id)
      .where('target_tenant_id', '=', targetTenantId)
      .where('consumed_at', 'is', null)
      .where('failed_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return null;
    const attempts = row.attempt_count + 1;
    const failed = attempts >= maxAttempts;
    await trx
      .updateTable('cross_tenant_events')
      .set({
        attempt_count: attempts,
        last_error: detail,
        next_attempt_at: failed ? null : new Date(now.getTime() + crossTenantEventBackoffMs(attempts)),
        failed_at: failed ? now : null,
      })
      .where('id', '=', id)
      .execute();
    return { attempts, failed };
  });
}
