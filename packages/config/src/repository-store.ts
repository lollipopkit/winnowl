import { resolveConfig, type ConfigLayer } from './merge.js';
import { repositoryConfigSchema, type EffectiveRepositoryConfig } from './schema.js';
import type { Db } from '@reviewbot/db';

/** Mirrors the repo-file config so the console and clone-less paths (gate, autofix, chat) can read it. */
export async function persistEffectiveConfig(
  db: Db,
  input: {
    tenantId: string;
    repositoryId: string;
    settings: EffectiveRepositoryConfig;
    configDigest: string;
    /** The `.winnowl.yaml` as written: the layer read-time resolution uses. */
    fileSettings?: Record<string, unknown>;
    now?: number;
  },
): Promise<void> {
  const updatedAt = new Date(input.now ?? Date.now());
  const settings = input.settings as unknown as Record<string, unknown>;
  const fileSettings = input.fileSettings ?? null;
  await db
    .insertInto('repository_settings')
    .values({
      repository_id: input.repositoryId,
      tenant_id: input.tenantId,
      settings,
      file_settings: fileSettings,
      config_digest: input.configDigest,
      source: 'repo-file', // the panel PUT writes 'panel'
      updated_at: updatedAt,
    })
    .onConflict((oc) =>
      oc.column('repository_id').doUpdateSet({
        settings,
        file_settings: fileSettings,
        config_digest: input.configDigest,
        source: 'repo-file',
        updated_at: updatedAt,
      }),
    )
    .execute();
}

/** The organization's defaults: the schema keys of `tenants.settings` (it also holds other keys). */
export async function loadOrganizationLayer(db: Db, tenantId: string): Promise<ConfigLayer | null> {
  const tenant = await db.selectFrom('tenants').select('settings').where('id', '=', tenantId).executeTakeFirst();
  const fragment = tenant?.settings;
  if (!fragment || typeof fragment !== 'object') return null;
  const known = new Set(Object.keys(repositoryConfigSchema.shape));
  const value = Object.fromEntries(Object.entries(fragment).filter(([k]) => known.has(k)));
  return Object.keys(value).length > 0 ? { source: 'organization', value } : null;
}

/** The console panel's layer; null when never saved in the panel (`{}` is a save that kept every default). */
export async function loadPanelLayer(db: Db, repositoryId: string): Promise<ConfigLayer | null> {
  const row = await db.selectFrom('repository_settings').select('panel_settings').where('repository_id', '=', repositoryId).executeTakeFirst();
  const panel = row?.panel_settings;
  return panel && typeof panel === 'object' ? { source: 'repository-db', value: panel } : null;
}

/**
 * Resolved at read time from the organization's defaults, the panel and the repository file, so a change to
 * the organization's defaults applies everywhere at once. The repository file layer lags one review behind.
 */
export async function loadEffectiveConfig(db: Db, tenantId: string, repositoryId: string): Promise<EffectiveRepositoryConfig> {
  const row = await db
    .selectFrom('repository_settings')
    .select(['settings', 'panel_settings', 'file_settings', 'source'])
    .where('tenant_id', '=', tenantId)
    .where('repository_id', '=', repositoryId)
    .executeTakeFirst();
  const layers: ConfigLayer[] = [];
  const organization = await loadOrganizationLayer(db, tenantId);
  if (organization) layers.push(organization);
  // TODO(remove once every repository was reviewed and saved after 0020): rows written before the layers were
  // stored only have the resolved `settings`, which stands in for the layer its last writer owns.
  const legacy = row?.settings && Object.keys(row.settings).length > 0 ? row.settings : null;
  const panel = row?.panel_settings ?? (row?.source === 'panel' ? legacy : null);
  const file = row?.file_settings ?? (row?.source === 'repo-file' ? legacy : null);
  if (panel) layers.push({ source: 'repository-db', value: panel });
  if (file) layers.push({ source: 'repository-file', value: file });
  return resolveConfig(layers).config;
}
