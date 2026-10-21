import { randomBytes } from 'node:crypto';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { createLocalMasterKey } from '@reviewbot/kms';
import { storeWebhookSecret } from '@reviewbot/provider-factory';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKmsSecretResolver } from '../src/context.js';
import type { IngestContext } from '../src/types.js';

const TENANT = uuidv7();
const HOST = uuidv7();

describe('KMS webhook secret resolver', () => {
  let stop: () => Promise<void>;
  let db: Db;
  const kek = createLocalMasterKey('kek-wh', randomBytes(32));

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await storeWebhookSecret(db, kek, { tenantId: TENANT, hostId: HOST, secret: 'super-secret-hmac' });
  });

  afterAll(async () => {
    await stop?.();
  });

  const ctx = (hostId: string): IngestContext => ({ provider: 'github', tenantId: TENANT, providerHostId: hostId, installationId: 'i' });

  it('已落库 host → 从 KMS 解密返回 secret', async () => {
    const resolve = createKmsSecretResolver(db, kek, async () => 'env-fallback');
    expect(await resolve(ctx(HOST))).toBe('super-secret-hmac');
  });

  it('未落库 host → 回退 fallback', async () => {
    const resolve = createKmsSecretResolver(db, kek, async () => 'env-fallback');
    expect(await resolve(ctx(uuidv7()))).toBe('env-fallback');
  });
});
