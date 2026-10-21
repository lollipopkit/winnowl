/**
 * CORS with credentials for exact origins from {@link allowedOrigins} (the CSRF allowlist); others get no CORS headers.
 * Access is still decided by the session, never by origin.
 */
import type { FastifyInstance } from 'fastify';
import { allowedOrigins } from './csrf.js';

const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE';
const ALLOWED_HEADERS = 'content-type, x-tenant-id';
const PREFLIGHT_MAX_AGE_SEC = '600';

/** Must be registered before rbac so a preflight is answered without resolving a session. */
export function registerCors(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  const allowed = allowedOrigins(env);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('vary', 'Origin');
    const origin = req.headers.origin;
    const trusted = typeof origin === 'string' && allowed.has(origin);
    if (trusted) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
    }
    if (req.method !== 'OPTIONS' || !req.headers['access-control-request-method']) return;
    if (!trusted) return reply.code(403).send({ error: 'cors_origin_rejected' });
    reply.header('access-control-allow-methods', ALLOWED_METHODS);
    reply.header('access-control-allow-headers', ALLOWED_HEADERS);
    reply.header('access-control-max-age', PREFLIGHT_MAX_AGE_SEC);
    return reply.code(204).send();
  });
}
