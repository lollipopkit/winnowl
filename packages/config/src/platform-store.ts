import type { Db } from '@reviewbot/db';
import { resolvePlatformSetting } from './platform.js';

/** All stored platform settings, read afresh. A failed read is empty so callers fall back to env / default. */
export async function readPlatformSettings(db: Db): Promise<Map<string, string>> {
  try {
    const rows = await db.selectFrom('platform_settings').select(['key', 'value']).execute();
    return new Map(rows.map((r) => [r.key, r.value]));
  } catch {
    return new Map();
  }
}

/** One platform setting resolved DB → env → default, read afresh so console changes apply to the next job. */
export async function platformSetting(db: Db, key: string): Promise<string> {
  let fromDb: string | undefined;
  try {
    const row = await db.selectFrom('platform_settings').select('value').where('key', '=', key).executeTakeFirst();
    fromDb = row?.value;
  } catch {
    /* env / default */
  }
  return resolvePlatformSetting(key, fromDb).value;
}
