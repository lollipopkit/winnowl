import type { Db } from '@reviewbot/db';
import type { MasterKeyProvider } from '@reviewbot/kms';
import {
  BYOK_PROVIDERS,
  ByokCheckError,
  ByokConfigError,
  deleteByokConfig,
  deleteServiceCredential,
  isByokProvider,
  isKnownService,
  knownByokModelSpecs,
  listByokModels,
  listByokRepositories,
  listServiceCredentials,
  parseByokUpdate,
  readByokConfig,
  readByokMeta,
  storeByokConfig,
  storeServiceCredential,
  verifyByokConfig,
  type ByokProvider,
} from '@reviewbot/plugins';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requirePermission } from '../rbac.js';

/** Service API keys at org/repo level (`installation:manage`). Keys are write-only; GET returns metadata only. */
export function registerServiceCredentialRoutes(
  app: FastifyInstance,
  db: Db,
  masterKey: MasterKeyProvider,
  /** Requests to the BYOK providers (key check, model list); tests inject a fake. */
  byokFetch: typeof fetch = fetch,
): void {
  type ByokScope = { tenantId: string; repositoryId?: string; userId?: string };
  const providers = Object.keys(BYOK_PROVIDERS);

  /** Refusals the console explains: `reason` is the code it localises, `field` the input it marks. */
  const byokRefusal = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ByokConfigError) {
      return reply.code(400).send({ error: 'invalid_byok_config', reason: e.code, ...(e.field ? { field: e.field } : {}), message: e.message });
    }
    if (e instanceof ByokCheckError) {
      // A rejected key is the caller's to fix; a provider that cannot be asked is not.
      return reply.code(e.code === 'key_rejected' ? 400 : 502).send({ error: 'byok_check_failed', reason: e.code, message: e.message });
    }
    throw e;
  };

  /** An omitted key reuses the stored key of the same scope and provider. */
  const keyFor = async (scope: ByokScope, provider: ByokProvider, apiKey: string | undefined): Promise<string> => {
    if (apiKey) return apiKey;
    const stored = await readByokConfig(db, masterKey, scope).catch(() => null);
    if (stored?.provider === provider) return stored.apiKey;
    throw new ByokConfigError('missing_field', 'apiKey', 'BYOK configuration is missing apiKey');
  };

  /** Validates, checks with the provider, and stores. */
  const putByok = async (reply: FastifyReply, scope: ByokScope, body: Record<string, unknown>) => {
    try {
      const input = parseByokUpdate(body, { keyOptional: true });
      const config = { ...input, apiKey: await keyFor(scope, input.provider, input.apiKey) };
      await verifyByokConfig(db, config, byokFetch);
      await storeByokConfig(db, masterKey, scope, config);
    } catch (e) {
      return byokRefusal(reply, e);
    }
    return reply.code(204).send();
  };

  /** The models the key can use, each marked by whether the platform knows its specification. */
  const listModels = async (reply: FastifyReply, scope: ByokScope, body: { provider?: unknown; apiKey?: unknown }) => {
    const provider = typeof body.provider === 'string' ? body.provider : '';
    if (!isByokProvider(provider)) return reply.code(400).send({ error: 'invalid_byok_config', reason: 'unknown_provider', field: 'provider' });
    try {
      const apiKey = await keyFor(scope, provider, typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : undefined);
      const ids = await listByokModels(provider, apiKey, byokFetch);
      const known = await knownByokModelSpecs(db, provider, ids);
      return reply.send({ models: ids.map((id) => ({ id, known: known.has(id) })) });
    } catch (e) {
      return byokRefusal(reply, e);
    }
  };

  app.put('/v1/service-credentials', { preHandler: requirePermission('installation:manage') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const body = (req.body ?? {}) as { service?: string; apiKey?: string; repositoryId?: string };
    if (!body.service || !isKnownService(body.service)) return reply.code(400).send({ error: 'unknown_service' });
    if (!body.apiKey?.trim()) return reply.code(400).send({ error: 'apiKey_required' });
    if (body.repositoryId) {
      const repo = await db
        .selectFrom('repositories')
        .select('id')
        .where('id', '=', body.repositoryId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!repo) return reply.code(404).send({ error: 'repository_not_found' });
    }
    await storeServiceCredential(db, masterKey, {
      tenantId,
      service: body.service,
      apiKey: body.apiKey.trim(),
      ...(body.repositoryId ? { repositoryId: body.repositoryId } : {}),
    });
    // Never echo plaintext or ciphertext.
    return reply.code(204).send();
  });

  app.get('/v1/service-credentials', { preHandler: requirePermission('installation:manage') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    return reply.send({ credentials: await listServiceCredentials(db, tenantId) });
  });

  app.delete('/v1/service-credentials', { preHandler: requirePermission('installation:manage') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const body = (req.body ?? {}) as { service?: string; repositoryId?: string };
    if (!body.service || !isKnownService(body.service)) return reply.code(400).send({ error: 'unknown_service' });
    await deleteServiceCredential(db, {
      tenantId,
      service: body.service,
      ...(body.repositoryId ? { repositoryId: body.repositoryId } : {}),
    });
    return reply.code(204).send();
  });

  // BYOK at org/repo level. No URL fields are accepted (endpoints are hard-coded); the key is verified
  // with the provider before saving, never echoed, and reused from storage when omitted.
  const repoOfTenant = async (tenantId: string, repositoryId: string): Promise<boolean> =>
    !!(await db.selectFrom('repositories').select('id').where('id', '=', repositoryId).where('tenant_id', '=', tenantId).executeTakeFirst());

  app.put('/v1/byok', { preHandler: requirePermission('installation:manage') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const { repositoryId, ...config } = (req.body ?? {}) as Record<string, unknown> & { repositoryId?: string };
    if (repositoryId && !(await repoOfTenant(tenantId, repositoryId))) return reply.code(404).send({ error: 'repository_not_found' });
    return putByok(reply, { tenantId, ...(repositoryId ? { repositoryId } : {}) }, config);
  });

  app.post('/v1/byok/models', { preHandler: requirePermission('installation:manage') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const body = (req.body ?? {}) as { provider?: unknown; apiKey?: unknown; repositoryId?: string };
    if (body.repositoryId && !(await repoOfTenant(tenantId, body.repositoryId))) return reply.code(404).send({ error: 'repository_not_found' });
    return listModels(reply, { tenantId, ...(body.repositoryId ? { repositoryId: body.repositoryId } : {}) }, body);
  });

  /**
   * One scope's configuration (never the key). A repository without its own gets the organisation's
   * as `inherited`; the organisation scope lists repositories with their own.
   */
  app.get('/v1/byok', { preHandler: requirePermission('installation:manage') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const q = (req.query ?? {}) as { repositoryId?: string };
    const meta = await readByokMeta(db, masterKey, { tenantId, ...(q.repositoryId ? { repositoryId: q.repositoryId } : {}) });
    if (q.repositoryId) {
      const inherited = meta ? null : await readByokMeta(db, masterKey, { tenantId });
      return reply.send({ byok: meta, inherited, providers });
    }
    return reply.send({ byok: meta, repositories: await listByokRepositories(db, tenantId), providers });
  });

  app.delete('/v1/byok', { preHandler: requirePermission('installation:manage') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const body = (req.body ?? {}) as { repositoryId?: string };
    await deleteByokConfig(db, { tenantId, ...(body.repositoryId ? { repositoryId: body.repositoryId } : {}) });
    return reply.code(204).send();
  });

  // User-level keys for oneself (viewer+). Requires DB authz for auth.userId; precedence user > repo > org.
  app.put('/v1/my/service-credentials', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const { tenantId, userId } = req.auth ?? {};
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    if (!userId) return reply.code(400).send({ error: 'user_context_required' });
    const body = (req.body ?? {}) as { service?: string; apiKey?: string };
    if (!body.service || !isKnownService(body.service)) return reply.code(400).send({ error: 'unknown_service' });
    if (!body.apiKey?.trim()) return reply.code(400).send({ error: 'apiKey_required' });
    await storeServiceCredential(db, masterKey, { tenantId, service: body.service, apiKey: body.apiKey.trim(), userId });
    return reply.code(204).send();
  });

  app.delete('/v1/my/service-credentials', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const { tenantId, userId } = req.auth ?? {};
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    if (!userId) return reply.code(400).send({ error: 'user_context_required' });
    const body = (req.body ?? {}) as { service?: string };
    if (!body.service || !isKnownService(body.service)) return reply.code(400).send({ error: 'unknown_service' });
    await deleteServiceCredential(db, { tenantId, service: body.service, userId });
    return reply.code(204).send();
  });

  app.get('/v1/my/service-credentials', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const { tenantId, userId } = req.auth ?? {};
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    if (!userId) return reply.code(400).send({ error: 'user_context_required' });
    const all = await listServiceCredentials(db, tenantId);
    return reply.send({ credentials: all.filter((c) => c.scope === 'user' && c.userId === userId) });
  });

  // User-level BYOK for oneself (viewer+); same validation as org/repo.
  app.put('/v1/my/byok', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const { tenantId, userId } = req.auth ?? {};
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    if (!userId) return reply.code(400).send({ error: 'user_context_required' });
    return putByok(reply, { tenantId, userId }, (req.body ?? {}) as Record<string, unknown>);
  });

  app.post('/v1/my/byok/models', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const { tenantId, userId } = req.auth ?? {};
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    if (!userId) return reply.code(400).send({ error: 'user_context_required' });
    return listModels(reply, { tenantId, userId }, (req.body ?? {}) as { provider?: unknown; apiKey?: unknown });
  });

  app.get('/v1/my/byok', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const { tenantId, userId } = req.auth ?? {};
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    if (!userId) return reply.code(400).send({ error: 'user_context_required' });
    return reply.send({ byok: await readByokMeta(db, masterKey, { tenantId, userId }), providers }); // never includes apiKey
  });

  app.delete('/v1/my/byok', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const { tenantId, userId } = req.auth ?? {};
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    if (!userId) return reply.code(400).send({ error: 'user_context_required' });
    await deleteByokConfig(db, { tenantId, userId });
    return reply.code(204).send();
  });
}
