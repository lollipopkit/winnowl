import type { FastifyInstance } from 'fastify';
import type { Db } from '@reviewbot/db';
import { PLATFORM_SETTINGS, isValidPlatformSetting, platformSettingDef, resolveAllPlatformSettings } from '@reviewbot/config';
import { requirePermission } from '../rbac.js';
import { isPlatformOperator } from '../platform-operator.js';

/**
 * Cross-tenant settings, gated by isPlatformOperator. Each value reports its `source`
 * (database/environment/default).
 */
export function registerPlatformSettingsRoutes(app: FastifyInstance, db: Db): void {
  const operatorOnly = requirePermission('review:read');

  app.get('/v1/platform/settings', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const rows = await db.selectFrom('platform_settings').select(['key', 'value', 'updated_at', 'updated_by']).execute();
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const meta = new Map(rows.map((r) => [r.key, r]));
    return {
      items: resolveAllPlatformSettings(byKey).map((s) => {
        const def = platformSettingDef(s.key)!;
        const row = meta.get(s.key);
        return {
          ...s,
          values: def.values,
          description: def.description,
          env: def.env,
          ...(row ? { updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by } : {}),
        };
      }),
    };
  });

  app.put('/v1/platform/settings/:key', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const key = (req.params as { key?: string }).key ?? '';
    const value = (req.body as { value?: unknown })?.value;
    if (typeof value !== 'string' || !isValidPlatformSetting(key, value)) {
      // Reject unknown keys and invalid values rather than silently ignoring them.
      const def = platformSettingDef(key);
      return reply.code(400).send({
        error: def ? 'invalid_value' : 'unknown_setting',
        ...(def ? { allowed: def.values } : { allowed: PLATFORM_SETTINGS.map((s) => s.key) }),
      });
    }
    const now = new Date();
    const actor = req.auth?.actorId ?? null;
    await db.transaction().execute(async (tx) => {
      const old = await tx.selectFrom('platform_settings').select('value').where('key', '=', key).forUpdate().executeTakeFirst();
      await tx
        .insertInto('platform_settings')
        .values({ key, value, updated_at: now, updated_by: actor })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_at: now, updated_by: actor }))
        .execute();
      if (old?.value !== value) await recordChange(tx, key, old?.value ?? null, value, actor);
    });
    return { ok: true, key, value };
  });

  /** Delete = revert to env/default. */
  app.delete('/v1/platform/settings/:key', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const key = (req.params as { key?: string }).key ?? '';
    if (!platformSettingDef(key)) return reply.code(400).send({ error: 'unknown_setting' });
    await db.transaction().execute(async (tx) => {
      const old = await tx.deleteFrom('platform_settings').where('key', '=', key).returning('value').executeTakeFirst();
      if (old) await recordChange(tx, key, old.value, null, req.auth?.actorId ?? null);
    });
    return { ok: true, key };
  });

  app.get('/v1/platform/settings/:key/history', { preHandler: operatorOnly }, async (req, reply) => {
    if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
    const key = (req.params as { key?: string }).key ?? '';
    if (!platformSettingDef(key)) return reply.code(400).send({ error: 'unknown_setting' });
    const rows = await db
      .selectFrom('platform_setting_changes')
      .select(['old_value', 'new_value', 'actor', 'changed_at'])
      .where('key', '=', key)
      .orderBy('changed_at', 'desc')
      .limit(50)
      .execute();
    return {
      items: rows.map((r) => ({ oldValue: r.old_value, newValue: r.new_value, actor: r.actor, changedAt: r.changed_at.toISOString() })),
    };
  });
}

async function recordChange(db: Db, key: string, oldValue: string | null, newValue: string | null, actor: string | null): Promise<void> {
  await db
    .insertInto('platform_setting_changes')
    .values({ id: crypto.randomUUID(), key, old_value: oldValue, new_value: newValue, actor })
    .execute();
}
