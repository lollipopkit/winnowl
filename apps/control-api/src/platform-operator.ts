import type { preHandlerAsyncHookHandler } from 'fastify';
import type { AuthContext } from './rbac.js';

/**
 * Platform operators are cross-tenant and independent of tenant roles, so they come from an env allowlist.
 * Entries are `provider:subject` (e.g. `github:10864310`): bare ids collide across forges.
 */

function operatorIdentities(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.PLATFORM_OPERATOR_IDENTITIES ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isPlatformOperator(auth: AuthContext | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const identity = auth?.identity;
  if (!identity) return false;
  return operatorIdentities(env).has(`${identity.provider}:${identity.subject}`.toLowerCase());
}

export const requirePlatformOperator: preHandlerAsyncHookHandler = async (req, reply) => {
  if (!isPlatformOperator(req.auth)) {
    await reply.code(403).send({ error: 'forbidden', reason: 'platform_operator_required' });
  }
};
