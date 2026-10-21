import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { createLocalMasterKey, type MasterKeyProvider } from '@reviewbot/kms';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  byokModelSpec,
  ByokCheckError,
  deleteByokConfig,
  knownByokModelSpecs,
  parseByokConfig,
  parseByokUpdate,
  readByokMeta,
  recordByokOutcome,
  resolveByok,
  storeByokConfig,
  verifyByokConfig,
  type ByokConfig,
} from '../src/index.js';

/** resolveByok's configuration, or undefined (not configured / unreadable). */
const resolveByokConfig = async (...args: Parameters<typeof resolveByok>): Promise<ByokConfig | undefined> => {
  const r = await resolveByok(...args);
  return r && 'config' in r ? r.config : undefined;
};

/** A provider that knows `models` and accepts only `key`. */
const fakeProvider =
  (models: string[], key = 'sk-good'): typeof fetch =>
  async (_url, init) => {
    const h = new Headers(init?.headers);
    const given = h.get('x-api-key') ?? h.get('authorization')?.replace(/^Bearer /, '');
    if (given !== key) return new Response('{}', { status: 401 });
    return Response.json({ data: models.map((id) => ({ id })) });
  };

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const OTHER_REPO = uuidv7();
const USER = uuidv7();

describe('BYOK LLM 配置(todos §BYOK;service_credentials service=llm)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let kek: MasterKeyProvider;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    kek = createLocalMasterKey('kek-test', randomBytes(32));
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('users').values({ id: USER, email: 'u@acme.io', display_name: 'U', created_at: new Date() }).execute();
    for (const [i, id] of [REPO, OTHER_REPO].entries()) {
      await db.insertInto('repositories').values({ id, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: `80${i}`, namespace: 'acme', name: `b${i}`, clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    }
  });

  afterAll(async () => {
    await stop?.();
  });

  it('parseByokConfig:未知 provider / 多余字段(URL 类)/ 缺字段 一律拒绝(fail-closed)', () => {
    expect(() => parseByokConfig({ provider: 'evil-llm', model: 'm', apiKey: 'k' })).toThrow(/not supported/);
    expect(() => parseByokConfig({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'https://evil.example' })).toThrow(/does not accept "baseUrl"/);
    expect(() => parseByokConfig({ provider: 'openai', model: 'm', apiKey: 'k', gateway: 'x' })).toThrow(/does not accept/);
    expect(() => parseByokConfig({ provider: 'openai', model: 'm' })).toThrow(/missing apiKey/);
    expect(() => parseByokConfig({ provider: 'openai', model: '  ', apiKey: 'k' })).toThrow(/missing model/);
    // Changing the model of a stored configuration may omit the key.
    expect(parseByokUpdate({ provider: 'openai', model: ' m ' }, { keyOptional: true })).toEqual({ provider: 'openai', model: 'm' });
  });

  it('org 级存取:密文落库不含明文;resolve 还原;meta 不含 apiKey', async () => {
    await storeByokConfig(db, kek, { tenantId: TENANT }, parseByokConfig({ provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'sk-org-secret' }));
    const rows = await db.selectFrom('service_credentials').selectAll().where('tenant_id', '=', TENANT).where('service', '=', 'llm').execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.envelope)).not.toContain('sk-org-secret');

    const cfg = await resolveByokConfig(db, kek, { tenantId: TENANT, repositoryId: REPO });
    expect(cfg).toMatchObject({ provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'sk-org-secret' });

    const meta = await readByokMeta(db, kek, { tenantId: TENANT });
    expect(meta).toEqual({ provider: 'openai', model: 'gpt-5.6-sol' });
    expect(JSON.stringify(meta)).not.toContain('sk-org-secret');
  });

  it('status: a fallback after the last use is shown until the next use; saving clears it', async () => {
    const id = (await resolveByok(db, kek, { tenantId: TENANT, repositoryId: REPO }))!.id;
    await recordByokOutcome(db, id);
    expect(await readByokMeta(db, kek, { tenantId: TENANT })).toMatchObject({ lastUsedAt: expect.any(String) });
    await new Promise((r) => setTimeout(r, 5));
    await recordByokOutcome(db, id, 'model_unknown');
    expect(await readByokMeta(db, kek, { tenantId: TENANT })).toMatchObject({ lastError: 'model_unknown', lastErrorAt: expect.any(String) });
    await new Promise((r) => setTimeout(r, 5));
    await recordByokOutcome(db, id);
    expect((await readByokMeta(db, kek, { tenantId: TENANT }))?.lastError).toBeUndefined();
    await recordByokOutcome(db, id, 'provider_disabled');
    await storeByokConfig(db, kek, { tenantId: TENANT }, parseByokConfig({ provider: 'openai', model: 'gpt-5.6-sol', apiKey: 'sk-org-secret' }));
    expect(await readByokMeta(db, kek, { tenantId: TENANT })).toEqual({ provider: 'openai', model: 'gpt-5.6-sol' });
  });

  it('model specification: pi catalog, template, or the models.dev catalog', async () => {
    expect(await byokModelSpec(db, 'openai', 'gpt-4o')).toEqual({});
    expect(await byokModelSpec(db, 'openai', 'gpt-from-the-future')).toBeUndefined();
    expect(await byokModelSpec(db, 'openai', 'gpt-from-the-future', 'gpt-4o')).toEqual({});
    await db
      .insertInto('model_catalog')
      .values({ source: 'models.dev', provider: 'openai', model_id: 'gpt-from-the-future', name: 'Future', context_window: 400000, max_tokens: 64000, reasoning: true, input: 'text,image', cost: { input: 1, output: 8 } })
      .execute();
    expect(await byokModelSpec(db, 'openai', 'gpt-from-the-future')).toEqual({
      metadata: { name: 'Future', contextWindow: 400000, maxTokens: 64000, reasoning: true, input: ['text', 'image'], cost: { input: 1, output: 8 } },
    });
    expect([...(await knownByokModelSpecs(db, 'openai', ['gpt-4o', 'gpt-from-the-future', 'nope']))].sort()).toEqual(['gpt-4o', 'gpt-from-the-future']);
  });

  it('verifyByokConfig: the key must work, each model be offered to it and have a known specification', async () => {
    const cfg = (o: Partial<ByokConfig> = {}): ByokConfig => ({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-good', ...o });
    await expect(verifyByokConfig(db, cfg(), fakeProvider(['gpt-4o']))).resolves.toBeUndefined();
    await expect(verifyByokConfig(db, cfg({ apiKey: 'sk-bad' }), fakeProvider(['gpt-4o']))).rejects.toMatchObject({ code: 'key_rejected' });
    await expect(verifyByokConfig(db, cfg({ modelCheap: 'gpt-4o-mini' }), fakeProvider(['gpt-4o']))).rejects.toMatchObject({
      code: 'model_unavailable',
      field: 'modelCheap',
    });
    await expect(verifyByokConfig(db, cfg({ model: 'mystery' }), fakeProvider(['mystery']))).rejects.toMatchObject({ code: 'model_spec_unknown', field: 'model' });
    await expect(verifyByokConfig(db, cfg({ templateModel: 'nope' }), fakeProvider(['gpt-4o']))).rejects.toMatchObject({ code: 'model_spec_unknown', field: 'templateModel' });
    const down: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const err = await verifyByokConfig(db, cfg(), down).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ByokCheckError);
    expect((err as ByokCheckError).code).toBe('provider_unreachable');
    expect((err as Error).message).not.toContain('sk-good');
  });

  it('repo 级覆盖 org 级;其它 repo 用 org 级;delete 后回退', async () => {
    await storeByokConfig(
      db,
      kek,
      { tenantId: TENANT, repositoryId: REPO },
      parseByokConfig({ provider: 'deepseek', model: 'deepseek-v4', apiKey: 'sk-repo', modelCheap: 'deepseek-v4-lite' }),
    );
    expect((await resolveByokConfig(db, kek, { tenantId: TENANT, repositoryId: REPO }))?.provider).toBe('deepseek');
    expect((await resolveByokConfig(db, kek, { tenantId: TENANT, repositoryId: OTHER_REPO }))?.provider).toBe('openai');

    await deleteByokConfig(db, { tenantId: TENANT, repositoryId: REPO });
    expect((await resolveByokConfig(db, kek, { tenantId: TENANT, repositoryId: REPO }))?.provider).toBe('openai');
  });

  it('user 级覆盖 repo/org(仅用户发起链路);无 userId 退回 repo>org;user meta 精确本人;delete 回退', async () => {
    // Setup: org=openai (stored by case 1); repo=deepseek (re-stored, case 2 deleted it).
    await storeByokConfig(db, kek, { tenantId: TENANT, repositoryId: REPO }, parseByokConfig({ provider: 'deepseek', model: 'deepseek-v4', apiKey: 'sk-repo' }));
    await storeByokConfig(db, kek, { tenantId: TENANT, userId: USER }, parseByokConfig({ provider: 'anthropic', model: 'claude-x', apiKey: 'sk-user' }));

    // User-initiated (with userId): user > repo > org.
    expect((await resolveByokConfig(db, kek, { tenantId: TENANT, repositoryId: REPO, userId: USER }))?.provider).toBe('anthropic');
    // Webhook review (no userId): repo > org, never the user's key.
    expect((await resolveByokConfig(db, kek, { tenantId: TENANT, repositoryId: REPO }))?.provider).toBe('deepseek');
    // User meta is exactly this user's, without plaintext.
    const meta = await readByokMeta(db, kek, { tenantId: TENANT, userId: USER });
    expect(meta).toEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(JSON.stringify(meta)).not.toContain('sk-user');

    // After deleting the user level, user-initiated runs fall back to repo.
    await deleteByokConfig(db, { tenantId: TENANT, userId: USER });
    expect((await resolveByokConfig(db, kek, { tenantId: TENANT, repositoryId: REPO, userId: USER }))?.provider).toBe('deepseek');
  });

  it('落库行被篡改(混入 baseUrl)→ resolve 拒绝该行按未配置回退(不放行越权字段)', async () => {
    // Simulate a stored row with disallowed fields by bypassing parse.
    const { encryptEnvelope } = await import('@reviewbot/kms');
    const evil = JSON.stringify({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'https://evil.example' });
    const envelope = (await encryptEnvelope(evil, kek)) as unknown as Record<string, unknown>;
    await db
      .updateTable('service_credentials')
      .set({ envelope })
      .where('tenant_id', '=', TENANT)
      .where('service', '=', 'llm')
      .execute();
    expect(await resolveByok(db, kek, { tenantId: TENANT, repositoryId: OTHER_REPO })).toMatchObject({ error: 'unreadable' });
  });
});
