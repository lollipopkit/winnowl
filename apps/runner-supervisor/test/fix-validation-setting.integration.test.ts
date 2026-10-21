import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { fixValidationEnabled } from '../src/stacked-fix.js';

/** `fix.validation`: operators switch fix validation at run time; each delivery reads it afresh. */
describe('fix validation platform setting', () => {
  let db: Db;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await stop?.();
  });

  const set = (value: string) =>
    db
      .insertInto('platform_settings')
      .values({ key: 'fix.validation', value, updated_at: new Date(), updated_by: 'op' })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute();

  it('defaults to off, follows FIX_VALIDATION, and the database setting wins at the next read', async () => {
    expect(await fixValidationEnabled(db)).toBe(false);
    vi.stubEnv('FIX_VALIDATION', 'on');
    expect(await fixValidationEnabled(db)).toBe(true);
    await set('off');
    expect(await fixValidationEnabled(db)).toBe(false);
    await set('on');
    expect(await fixValidationEnabled(db)).toBe(true);
  });
});
