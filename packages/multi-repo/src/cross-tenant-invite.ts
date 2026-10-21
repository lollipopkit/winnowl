import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Self-describing signed invite issued by the downstream tenant, so the upstream can reference the
 * downstream repository without a cross-tenant read. The key is a platform secret. Redeeming only
 * creates a `proposed` relationship; the downstream still has to approve it.
 */

export interface CrossTenantInvitePayload {
  /** Downstream tenant (receives notifications). */
  targetTenantId: string;
  /** Notifications open issues here. */
  targetRepositoryId: string;
  kind: string;
  /** epoch ms */
  expiresAt: number;
}

function encode(payload: CrossTenantInvitePayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Called by the downstream side; `ttlMs` defaults to 7 days. */
export function createCrossTenantInvite(
  secret: string,
  input: Omit<CrossTenantInvitePayload, 'expiresAt'> & { now?: number; ttlMs?: number },
): string {
  if (!secret) throw new Error('跨租户邀请需配置签名密钥(CROSS_TENANT_INVITE_SECRET)');
  const payload: CrossTenantInvitePayload = {
    targetTenantId: input.targetTenantId,
    targetRepositoryId: input.targetRepositoryId,
    kind: input.kind,
    expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? 7 * 24 * 60 * 60 * 1000),
  };
  const body = encode(payload);
  return `${body}.${sign(secret, body)}`;
}

/** null on any failure; callers answer 400 without the reason so this is not a probing oracle. No DB reads. */
export function verifyCrossTenantInvite(secret: string, token: string, now = Date.now()): CrossTenantInvitePayload | null {
  if (!secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, body));
  // timingSafeEqual throws on unequal lengths.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let payload: CrossTenantInvitePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CrossTenantInvitePayload;
  } catch {
    return null;
  }
  if (
    typeof payload.targetTenantId !== 'string' ||
    typeof payload.targetRepositoryId !== 'string' ||
    typeof payload.kind !== 'string' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return null;
  }
  if (payload.expiresAt <= now) return null;
  return payload;
}
