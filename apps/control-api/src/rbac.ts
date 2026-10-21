import {
  checkRateLimit,
  hasPermission,
  type ApiScope,
  type Permission,
  type RateLimitState,
  type Role,
} from '@reviewbot/rbac';
import { runWithTenant } from '@reviewbot/db';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

export interface AuthContext {
  role: Role;
  scopes: ApiScope[];
  tenantId?: string;
  /** Forge user id; ActionPlan confirmation must match it. */
  actorId?: string;
  userId?: string;
  /** Use this rather than the bare `actorId` where identity matters (e.g. operator allowlist): bare ids collide across forges. */
  identity?: { provider: string; issuer: string; subject: string; login?: string };
}

export type AuthResolver = (req: FastifyRequest) => AuthContext | Promise<AuthContext>;

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const ANONYMOUS: AuthContext = { role: 'viewer', scopes: [] };

/** Credentials present but invalid -> 401, so the frontend can re-login; missing credentials stay anonymous viewer. */
export class InvalidTokenError extends Error {
  constructor() {
    super('invalid_token');
    this.name = 'InvalidTokenError';
  }
}

export interface RbacOptions {
  resolveAuth?: AuthResolver;
  /** Fixed-window rate limit; omitted = unlimited. */
  rateLimit?: { limit: number; windowMs: number };
  now?: () => number;
}

/** Provider tokens never enter the auth context or reach the frontend. */
export function registerRbac(app: FastifyInstance, opts: RbacOptions = {}): void {
  const resolveAuth = opts.resolveAuth ?? ((): AuthContext => ANONYMOUS);
  const now = opts.now ?? ((): number => Date.now());
  const buckets = new Map<string, RateLimitState>();

  app.decorateRequest('auth', undefined);

  /** true = already replied 429; the caller must not call done. */
  const rateLimited = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!opts.rateLimit) return false;
    const key = req.ip;
    const result = checkRateLimit(buckets.get(key), {
      limit: opts.rateLimit.limit,
      windowMs: opts.rateLimit.windowMs,
      now: now(),
    });
    buckets.set(key, result.state);
    reply.header('x-ratelimit-remaining', String(result.remaining));
    if (result.allowed) return false;
    void reply.code(429).send({ error: 'rate_limited', resetAt: result.resetAt });
    return true;
  };

  /*
   * Binds the tenant to the rest of the request for RLS. The hook must be callback-style so `done` runs
   * inside `als.run`; an async hook with enterWith leaves the handler without a tenant, which disables RLS.
   */
  app.addHook('onRequest', (req: FastifyRequest, reply: FastifyReply, done) => {
    // done() continues into later Fastify steps whose errors also land in this catch; guard against calling it twice.
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      done();
    };
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      if (err instanceof InvalidTokenError) {
        void reply.code(401).send({ error: 'invalid_token' });
        return;
      }
      done(err instanceof Error ? err : new Error(String(err)));
    };
    Promise.resolve()
      .then(() => resolveAuth(req))
      .then((auth) => {
        req.auth = auth;
        runWithTenant(auth.tenantId ?? null, () => {
          if (rateLimited(req, reply)) return;
          finish();
        });
      })
      .catch(fail);
  });
}

export function requirePermission(permission: Permission): preHandlerAsyncHookHandler {
  return async (req, reply) => {
    const auth = req.auth;
    if (!auth || !hasPermission(auth.role, permission)) {
      await reply.code(403).send({ error: 'forbidden', permission });
    }
  };
}
