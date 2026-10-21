/**
 * HS256 JWT in an httpOnly cookie, so page scripts cannot read it; CSRF is handled by registerCsrfGuard.
 * Key: `SESSION_SIGNING_KEY` (base64, >= 32 bytes), else HKDF-derived from `KMS_KEK_BASE64`; neither -> throw (no default).
 */
import { hkdfSync } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export const SESSION_COOKIE = 'winnowl_session';
/** Readable, credential-free hint that the user is probably logged in; authorization is always decided by the backend. */
export const AUTHED_HINT_COOKIE = 'winnowl_authed';

const ISSUER = 'winnowl-control-api';
const AUDIENCE = 'winnowl-console';

/** Seconds; default 7 days, overridable via `SESSION_TTL_SEC`. */
export function sessionTtlSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SESSION_TTL_SEC);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7 * 24 * 3600;
}

/** `SESSION_COOKIE_INSECURE=1` is for local http only. */
export function cookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_COOKIE_INSECURE !== '1';
}

/** Rotating the key invalidates all sessions. */
export function sessionKey(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const explicit = env.SESSION_SIGNING_KEY;
  if (explicit) {
    const raw = Buffer.from(explicit, 'base64');
    if (raw.length < 32) throw new Error('SESSION_SIGNING_KEY 至少 32 字节(base64 编码后配置)');
    return new Uint8Array(raw);
  }
  const kek = env.KMS_KEK_BASE64;
  if (kek) {
    const raw = Buffer.from(kek, 'base64');
    if (raw.length < 32) throw new Error('KMS_KEK_BASE64 至少 32 字节');
    // Distinct HKDF info so the session key differs from the envelope-encryption KEK.
    return new Uint8Array(hkdfSync('sha256', raw, Buffer.alloc(0), Buffer.from('winnowl-session-v1'), 32));
  }
  throw new Error('缺少会话签名密钥:配置 SESSION_SIGNING_KEY 或 KMS_KEK_BASE64');
}

/** No role/tenant: authorization always comes from DB memberships. */
export interface SessionClaims {
  userId: string;
  provider: string;
  /** Same value as user_identities.issuer. */
  issuer: string;
  /** = AuthContext.actorId (same identity space as webhook actors). */
  subject: string;
  /** Display only. */
  login?: string;
}

export async function signSession(claims: SessionClaims, opts: { ttlSec?: number; key?: Uint8Array } = {}): Promise<string> {
  const ttl = opts.ttlSec ?? sessionTtlSec();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    uid: claims.userId,
    prov: claims.provider,
    fiss: claims.issuer,
    ...(claims.login ? { login: claims.login } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.subject)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(opts.key ?? sessionKey());
}

/** null on any failure. */
export async function verifySession(token: string, key?: Uint8Array): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key ?? sessionKey(), { issuer: ISSUER, audience: AUDIENCE });
    return claimsOf(payload);
  } catch {
    return null;
  }
}

function claimsOf(payload: JWTPayload): SessionClaims | null {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const subject = str(payload.sub);
  const userId = str(payload['uid']);
  const provider = str(payload['prov']);
  const issuer = str(payload['fiss']);
  if (!subject || !userId || !provider || !issuer) return null;
  const login = str(payload['login']);
  return { userId, provider, issuer, subject, ...(login ? { login } : {}) };
}
