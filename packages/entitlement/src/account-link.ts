import type { Db } from '@reviewbot/db';
import type { IdentityRef } from '@reviewbot/domain';

/**
 * Account linking. Callers must hold verified credentials for both sides; never infer a link from
 * email, since a self-hosted forge issuer can claim any address. Linking merges the loser user into the winner.
 */

const ROLE_RANK: Readonly<Record<string, number>> = { viewer: 0, member: 1, admin: 2, owner: 3 };

function strongerRole(a: string, b: string): string {
  return (ROLE_RANK[a] ?? 0) >= (ROLE_RANK[b] ?? 0) ? a : b;
}

export interface MergeResult {
  userId: string;
  /** Deleted. */
  mergedUserId: string;
  identitiesMoved: number;
  membershipsMoved: number;
  /** Same-tenant membership conflicts, resolved to the higher role. */
  membershipsMerged: number;
  credentialsMoved: number;
  /** Loser's user-level credentials dropped because the winner had one for the same (tenant, service). */
  credentialsDropped: number;
}

/**
 * Merges loser into winner in one transaction. Membership conflicts keep the higher role;
 * credential conflicts keep the winner's (the user can re-enter a key).
 */
export async function mergeUsers(db: Db, winnerUserId: string, loserUserId: string): Promise<MergeResult> {
  if (winnerUserId === loserUserId) {
    throw new Error('不能把用户合并到它自己');
  }

  return db.transaction().execute(async (trx) => {
    // Checked inside the transaction so a concurrent delete cannot leave rows pointing at a missing user.
    for (const id of [winnerUserId, loserUserId]) {
      const u = await trx.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst();
      if (!u) throw new Error(`用户不存在:${id}`);
    }

    const winnerMemberships = await trx
      .selectFrom('memberships')
      .select(['id', 'tenant_id', 'role'])
      .where('user_id', '=', winnerUserId)
      .execute();
    const loserMemberships = await trx
      .selectFrom('memberships')
      .select(['id', 'tenant_id', 'role', 'status'])
      .where('user_id', '=', loserUserId)
      .execute();

    let membershipsMerged = 0;
    for (const lm of loserMemberships) {
      const clash = winnerMemberships.find((wm) => wm.tenant_id === lm.tenant_id);
      if (!clash) continue;
      const keep = strongerRole(clash.role, lm.role);
      if (keep !== clash.role) {
        await trx.updateTable('memberships').set({ role: keep }).where('id', '=', clash.id).execute();
      }
      await trx.deleteFrom('memberships').where('id', '=', lm.id).execute();
      membershipsMerged += 1;
    }
    const movedMemberships = await trx
      .updateTable('memberships')
      .set({ user_id: winnerUserId })
      .where('user_id', '=', loserUserId)
      .executeTakeFirst();

    const winnerCreds = await trx
      .selectFrom('service_credentials')
      .select(['tenant_id', 'service'])
      .where('user_id', '=', winnerUserId)
      .execute();
    let credentialsDropped = 0;
    for (const wc of winnerCreds) {
      const dropped = await trx
        .deleteFrom('service_credentials')
        .where('user_id', '=', loserUserId)
        .where('tenant_id', '=', wc.tenant_id)
        .where('service', '=', wc.service)
        .executeTakeFirst();
      credentialsDropped += Number(dropped.numDeletedRows ?? 0);
    }
    const movedCreds = await trx
      .updateTable('service_credentials')
      .set({ user_id: winnerUserId })
      .where('user_id', '=', loserUserId)
      .executeTakeFirst();

    // Identities are unique by (kind, issuer, subject), so they cannot conflict.
    const movedIdentities = await trx
      .updateTable('user_identities')
      .set({ user_id: winnerUserId })
      .where('user_id', '=', loserUserId)
      .executeTakeFirst();

    // Otherwise ON DELETE SET NULL would erase who sent the invite.
    await trx.updateTable('tenant_invites').set({ invited_by: winnerUserId }).where('invited_by', '=', loserUserId).execute();

    await trx.deleteFrom('users').where('id', '=', loserUserId).execute();

    return {
      userId: winnerUserId,
      mergedUserId: loserUserId,
      identitiesMoved: Number(movedIdentities.numUpdatedRows ?? 0),
      membershipsMoved: Number(movedMemberships.numUpdatedRows ?? 0),
      membershipsMerged,
      credentialsMoved: Number(movedCreds.numUpdatedRows ?? 0),
      credentialsDropped,
    };
  });
}

export interface LinkedIdentity extends IdentityRef {
  id: string;
  createdAt: Date;
}

export async function listIdentities(db: Db, userId: string): Promise<LinkedIdentity[]> {
  const rows = await db
    .selectFrom('user_identities')
    .select(['id', 'kind', 'issuer', 'subject', 'login', 'provider', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === 'oidc' ? 'oidc' : 'provider',
    issuer: r.issuer,
    subject: r.subject,
    ...(r.login ? { login: r.login } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    createdAt: r.created_at as unknown as Date,
  }));
}

export type UnlinkResult = { ok: true } | { ok: false; reason: 'not_found' | 'last_identity' };

/** Refuses to remove the last identity, which would lock the user out. */
export async function unlinkIdentity(db: Db, userId: string, identityId: string): Promise<UnlinkResult> {
  const rows = await db.selectFrom('user_identities').select(['id']).where('user_id', '=', userId).execute();
  if (!rows.some((r) => r.id === identityId)) return { ok: false, reason: 'not_found' };
  if (rows.length <= 1) return { ok: false, reason: 'last_identity' };
  await db.deleteFrom('user_identities').where('id', '=', identityId).where('user_id', '=', userId).execute();
  return { ok: true };
}
