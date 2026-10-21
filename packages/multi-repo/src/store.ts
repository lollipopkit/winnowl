import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { RelationshipStatus, RepositoryRelationship, RepositoryRelationshipKind } from './types.js';

const KINDS: readonly RepositoryRelationshipKind[] = [
  'api-provider',
  'api-consumer',
  'shared-schema',
  'generated-client',
  'library-dependent',
  'deployment-dependent',
];

const STATUSES: readonly RelationshipStatus[] = ['proposed', 'active', 'rejected'];

const COLS = ['id', 'source_repository_id', 'target_repository_id', 'kind', 'instructions', 'enabled', 'status', 'proposed_by', 'rationale'] as const;

export interface UpsertRelationshipInput {
  sourceRepositoryId: string;
  targetRepositoryId: string;
  kind: RepositoryRelationshipKind;
  instructions?: string;
  enabled?: boolean;
}

function toDomain(row: {
  id: string;
  source_repository_id: string;
  target_repository_id: string;
  kind: string;
  instructions: string | null;
  enabled: boolean;
  status: string;
  proposed_by: string | null;
  rationale: string | null;
}): RepositoryRelationship {
  return {
    id: row.id,
    sourceRepositoryId: row.source_repository_id,
    targetRepositoryId: row.target_repository_id,
    kind: (KINDS as readonly string[]).includes(row.kind) ? (row.kind as RepositoryRelationshipKind) : 'api-consumer',
    ...(row.instructions ? { instructions: row.instructions } : {}),
    enabled: row.enabled,
    status: (STATUSES as readonly string[]).includes(row.status) ? (row.status as RelationshipStatus) : 'active',
    ...(row.proposed_by ? { proposedBy: row.proposed_by } : {}),
    ...(row.rationale ? { rationale: row.rationale } : {}),
  };
}

/** Manual upserts are active immediately. */
export async function upsertRelationship(db: Db, tenantId: string, input: UpsertRelationshipInput, now: Date = new Date()): Promise<string> {
  const id = uuidv7();
  const enabled = input.enabled ?? true;
  const row = await db
    .insertInto('repository_relationships')
    .values({
      id,
      tenant_id: tenantId,
      source_repository_id: input.sourceRepositoryId,
      target_repository_id: input.targetRepositoryId,
      kind: input.kind,
      instructions: input.instructions ?? null,
      enabled,
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['source_repository_id', 'target_repository_id', 'kind']).doUpdateSet({
        instructions: input.instructions ?? null,
        enabled,
        // A manual upsert is an admin decision: it overrides proposed/rejected.
        status: 'active',
        updated_at: now,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Never overrides an existing row (a rejected one is a lasting veto); null on conflict. */
export async function proposeRelationship(
  db: Db,
  tenantId: string,
  input: { sourceRepositoryId: string; targetRepositoryId: string; kind: RepositoryRelationshipKind; proposedBy: string; rationale: string },
  now: Date = new Date(),
): Promise<string | null> {
  const id = uuidv7();
  const row = await db
    .insertInto('repository_relationships')
    .values({
      id,
      tenant_id: tenantId,
      source_repository_id: input.sourceRepositoryId,
      target_repository_id: input.targetRepositoryId,
      kind: input.kind,
      instructions: null,
      // Belt and braces: authorization also requires status='active'.
      enabled: false,
      status: 'proposed',
      proposed_by: input.proposedBy,
      rationale: input.rationale,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['source_repository_id', 'target_repository_id', 'kind']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id ?? null;
}

/** Only from proposed; rejected rows are kept as a lasting veto. */
export async function transitionRelationship(
  db: Db,
  tenantId: string,
  id: string,
  action: 'approve' | 'reject',
  now: Date = new Date(),
): Promise<boolean> {
  const res = await db
    .updateTable('repository_relationships')
    .set(action === 'approve' ? { status: 'active', enabled: true, updated_at: now } : { status: 'rejected', enabled: false, updated_at: now })
    .where('id', '=', id)
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'proposed')
    .executeTakeFirst();
  return (res.numUpdatedRows ?? 0n) > 0n;
}

/** Enabled and active only; proposed/rejected never authorize anything. */
export async function loadEnabledRelationships(db: Db, sourceRepositoryId: string): Promise<RepositoryRelationship[]> {
  const rows = await db
    .selectFrom('repository_relationships')
    .select(COLS)
    .where('source_repository_id', '=', sourceRepositoryId)
    .where('enabled', '=', true)
    .where('status', '=', 'active')
    .execute();
  return rows.map(toDomain);
}

export async function listRelationships(db: Db, tenantId: string): Promise<RepositoryRelationship[]> {
  const rows = await db
    .selectFrom('repository_relationships')
    .select(COLS)
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(toDomain);
}

export async function setRelationshipEnabled(db: Db, tenantId: string, id: string, enabled: boolean, now: Date = new Date()): Promise<boolean> {
  const res = await db
    .updateTable('repository_relationships')
    .set({ enabled, updated_at: now })
    .where('id', '=', id)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return (res.numUpdatedRows ?? 0n) > 0n;
}
