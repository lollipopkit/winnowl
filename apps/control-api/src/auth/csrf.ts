/**
 * CSRF guard on top of SameSite=Lax (whose behaviour varies by browser). Applies to every browser-initiated
 * write, cookie or not: logout clears cookies without one, so a cookie-gated check lets cross-site forms log users out.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parseCookies } from './cookies.js';
import { SESSION_COOKIE } from './session.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Console URL plus `CSRF_ALLOWED_ORIGINS`. */
export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    for (const item of raw.split(',')) {
      const v = item.trim();
      if (!v) continue;
      try {
        out.add(new URL(v).origin);
      } catch {
        /* invalid entries are ignored */
      }
    }
  };
  add(env.CONSOLE_BASE_URL);
  add(env.CSRF_ALLOWED_ORIGINS);
  return out;
}

/**
 * Accepts an allowlisted `Origin` or `Sec-Fetch-Site: same-origin`: Safari omits Origin on some same-origin
 * POSTs, and older browsers lack Sec-Fetch-Site. Without either header the caller is not a browser, so it is
 * let through unless it carries the session cookie.
 */
export function registerCsrfGuard(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  const allowed = allowedOrigins(env);
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    if (typeof origin === 'string') {
      if (allowed.has(origin)) return;
    } else if (fetchSite === 'same-origin') {
      return;
    } else if (fetchSite === undefined && !parseCookies(req.headers.cookie)[SESSION_COOKIE]) {
      return;
    }
    await reply.code(403).send({ error: 'csrf_origin_rejected' });
  });
}
