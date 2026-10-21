import {
  ConfigValidationError,
  defaultConfig,
  loadOrganizationLayer,
  parseRepositoryConfig,
  pruneDefaults,
  repositoryConfigSchema,
  resolveConfig,
} from '@reviewbot/config';
import type { Db } from '@reviewbot/db';
import { isKnownService, PLUGIN_MANIFEST } from '@reviewbot/plugins';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../rbac.js';

/**
 * Exposes only the `plugins` key of tenants.settings; PUT replaces just that key.
 * An org-level false cannot be re-enabled at repo level.
 */
export function registerTenantSettingsRoutes(app: FastifyInstance, db: Db): void {
  app.get('/v1/tenant-settings', { preHandler: requirePermission('config:read') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const row = await db.selectFrom('tenants').select('settings').where('id', '=', tenantId).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'tenant_not_found' });
    return { settings: row.settings ?? {} };
  });

  app.put('/v1/tenant-settings', { preHandler: requirePermission('installation:manage') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const body = (req.body ?? {}) as { plugins?: Record<string, unknown> };
    if (!body.plugins || typeof body.plugins !== 'object' || Array.isArray(body.plugins)) {
      return reply.code(400).send({ error: 'plugins_required' });
    }
    const plugins: Record<string, { enabled: boolean }> = {};
    for (const [name, value] of Object.entries(body.plugins)) {
      if (!isKnownService(name)) return reply.code(400).send({ error: 'unknown_service', service: name });
      const enabled = (value as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'enabled_boolean_required', service: name });
      plugins[name] = { enabled };
    }
    const row = await db.selectFrom('tenants').select('settings').where('id', '=', tenantId).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'tenant_not_found' });
    const settings = { ...(row.settings ?? {}), plugins };
    await db.updateTable('tenants').set({ settings }).where('id', '=', tenantId).execute();
    return { settings };
  });

  /**
   * The organization's configuration defaults: every repository starts from them and overrides with its panel or
   * `.winnowl.yaml`. Stored as the schema keys of tenants.settings, only where they differ from the schema
   * defaults. `plugins` is left to PUT /v1/tenant-settings, so saving this form cannot reset plugin switches.
   */
  app.get('/v1/organization-config', { preHandler: requirePermission('config:read') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    const layer = await loadOrganizationLayer(db, tenantId);
    return { settings: resolveConfig(layer ? [layer] : []).config };
  });

  app.put('/v1/organization-config', { preHandler: requirePermission('installation:manage') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });
    let config;
    try {
      config = parseRepositoryConfig(req.body);
    } catch (err) {
      if (err instanceof ConfigValidationError) return reply.code(400).send({ error: 'invalid_config', message: err.message });
      throw err;
    }
    const row = await db.selectFrom('tenants').select('settings').where('id', '=', tenantId).executeTakeFirst();
    if (!row) return reply.code(404).send({ error: 'tenant_not_found' });
    const current = (row.settings ?? {}) as Record<string, unknown>;
    const configKeys = new Set(Object.keys(repositoryConfigSchema.shape));
    const defaults = pruneDefaults(config, defaultConfig());
    delete defaults.plugins;
    const kept = Object.fromEntries(Object.entries(current).filter(([k]) => !configKeys.has(k) || k === 'plugins'));
    const settings = { ...kept, ...defaults };
    await db.updateTable('tenants').set({ settings }).where('id', '=', tenantId).execute();
    return { ok: true };
  });

  app.get('/v1/plugins', { preHandler: requirePermission('config:read') }, async () => {
    return {
      plugins: PLUGIN_MANIFEST.map((m) => ({ name: m.name, publisher: m.publisher, upstream: m.upstream ?? null })),
    };
  });
}
