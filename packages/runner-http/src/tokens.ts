import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stateless HMAC-SHA256 tokens over `type:subject:exp`; the server only needs the shared secret. */
export interface TokenAuthority {
  issueRunnerToken(workerId: string, ttlSeconds?: number): string;
  verifyRunnerToken(token: string): { workerId: string } | null;
  issueJobToken(jobId: string, workerId: string, ttlSeconds?: number): string;
  verifyJobToken(token: string): { jobId: string; workerId: string } | null;
  /** Registration Token validation returns the server-authorized worker grant. */
  verifyRegistrationToken(presented: string): RegistrationGrant | null;
}

export interface RegistrationGrant {
  poolId: string;
  capabilities: Record<string, unknown>;
  maxConcurrency: number;
}

interface TokenAuthorityOptions {
  secret: string;
  registration: RegistrationGrant & { token: string };
  now?: () => number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function constantEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function createTokenAuthority(opts: TokenAuthorityOptions): TokenAuthority {
  const now = opts.now ?? ((): number => Date.now());
  const sign = (payload: string): string =>
    b64url(createHmac('sha256', opts.secret).update(payload).digest());

  const issue = (type: string, subject: string, ttlSeconds: number): string => {
    const exp = Math.floor(now() / 1000) + ttlSeconds;
    const payload = `${type}:${subject}:${exp}`;
    return `${b64url(Buffer.from(payload))}.${sign(payload)}`;
  };

  const verify = (type: string, token: string): string[] | null => {
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    let payload: string;
    try {
      payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const sig = token.slice(dot + 1);
    if (!constantEqual(sig, sign(payload))) return null;
    const parts = payload.split(':');
    if (parts[0] !== type) return null;
    const exp = Number(parts[parts.length - 1]);
    if (!Number.isFinite(exp) || Math.floor(now() / 1000) > exp) return null;
    return parts;
  };

  return {
    issueRunnerToken: (workerId, ttl = 3600) => issue('runner', workerId, ttl),
    verifyRunnerToken: (token) => {
      const p = verify('runner', token);
      return p && p.length === 3 ? { workerId: p[1]! } : null;
    },
    issueJobToken: (jobId, workerId, ttl = 3600) => issue('job', `${jobId}|${workerId}`, ttl),
    verifyJobToken: (token) => {
      const p = verify('job', token);
      if (!p || p.length !== 3) return null;
      const [jobId, workerId] = p[1]!.split('|');
      return jobId && workerId ? { jobId, workerId } : null;
    },
    verifyRegistrationToken: (presented) =>
      constantEqual(presented, opts.registration.token)
        ? {
            poolId: opts.registration.poolId,
            capabilities: opts.registration.capabilities,
            maxConcurrency: opts.registration.maxConcurrency,
          }
        : null,
  };
}
