import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createLocalMasterKey } from '@reviewbot/kms';
import { randomBytes } from 'node:crypto';
import { ArtifactEncryptedError, ArtifactTooLargeError, LocalArtifactStore, getArtifact, putArtifact } from '../src/index.js';

const TENANT = uuidv7();

describe('artifacts', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let dir: string;
  let store: LocalArtifactStore;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    dir = await mkdtemp(join(tmpdir(), 'rvb-artifacts-'));
    store = new LocalArtifactStore(dir);
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
  });

  afterAll(async () => {
    await stop?.();
    await rm(dir, { recursive: true, force: true });
  });

  it('上传后可读回,sha256 与大小正确', async () => {
    const ref = await putArtifact(db, store, { tenantId: TENANT, kind: 'log', content: 'hello world', contentType: 'text/plain' });
    expect(ref.bytes).toBe(11);
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.storageKey.startsWith(`${TENANT}/log/`)).toBe(true);

    const got = await getArtifact(db, store, ref.id);
    expect(got?.content.toString('utf8')).toBe('hello world');
    expect(got?.sha256).toBe(ref.sha256);
  });

  it('超过大小上限被拒绝', async () => {
    await expect(
      putArtifact(db, store, { tenantId: TENANT, kind: 'log', content: 'x'.repeat(100), maxBytes: 10 }),
    ).rejects.toBeInstanceOf(ArtifactTooLargeError);
  });

  it('提供 KEK → 信封加密落盘,对象存储只见密文,读回解密 + 完整性校验(§42.2)', async () => {
    const kek = createLocalMasterKey('test-kek', randomBytes(32));
    const secret = 'diff --git a/x b/x\n+sensitive patch content';
    const ref = await putArtifact(db, store, { tenantId: TENANT, kind: 'fix-patch', content: secret }, kek);
    expect(ref.bytes).toBe(Buffer.byteLength(secret)); // plaintext size

    const row = await db.selectFrom('artifacts').select(['encrypted', 'storage_key']).where('id', '=', ref.id).executeTakeFirstOrThrow();
    expect(row.encrypted).toBe(true);
    const rawStored = (await store.get(row.storage_key)).toString('utf8');
    expect(rawStored).not.toContain('sensitive patch content');
    expect(JSON.parse(rawStored)).toHaveProperty('wrappedDek');

    const got = await getArtifact(db, store, ref.id, kek);
    expect(got?.content.toString('utf8')).toBe(secret);
    expect(got?.sha256).toBe(ref.sha256);

    await expect(getArtifact(db, store, ref.id)).rejects.toBeInstanceOf(ArtifactEncryptedError);
  });

  it('设置 ttl 写入过期时间', async () => {
    const now = Date.parse('2026-07-15T00:00:00.000Z');
    const ref = await putArtifact(db, store, { tenantId: TENANT, kind: 'patch', content: 'diff', ttlDays: 30, now });
    const row = await db.selectFrom('artifacts').select('expires_at').where('id', '=', ref.id).executeTakeFirstOrThrow();
    expect(row.expires_at?.toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });
});
