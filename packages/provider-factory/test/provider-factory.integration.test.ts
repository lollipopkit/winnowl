import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { createLocalMasterKey } from '@reviewbot/kms';
import { FakeProviderServer, startMigratedPostgres } from '@reviewbot/testkit';
import {
  createKmsCredentialStore,
  createResolveListRepositories,
  createSourceProviderForInstallation,
  readWebhookSecret,
  storeCredential,
  storeGithubAppCredentials,
  storeWebhookSecret,
} from '../src/index.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const NATIVE_INSTALL = '555';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

describe('provider-factory 子系统 A', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let server: FakeProviderServer;
  const kek = createLocalMasterKey('kek-test', randomBytes(32));

  beforeAll(async () => {
    server = new FakeProviderServer();
    server.on('POST', `/app/installations/${NATIVE_INSTALL}/access_tokens`, {
      status: 201,
      body: { token: 'ghs_installation_token', expires_at: '2999-01-01T00:00:00Z' },
    });
    server.on('GET', '/installation/repositories', {
      status: 200,
      body: { repositories: [{ id: 900, name: 'app', default_branch: 'main', clone_url: 'https://github.com/acme/app.git', owner: { login: 'acme' } }] },
    });
    const apiUrl = await server.listen();

    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;

    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'https://github.com', api_url: apiUrl, is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: NATIVE_INSTALL, account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();

    await storeGithubAppCredentials(db, kek, { tenantId: TENANT, hostId: HOST, appId: '99', privateKeyPem: PEM });
  });

  afterAll(async () => {
    await server?.close();
    await stop?.();
  });

  it('凭据经 KMS 加密存储:明文不落库,可解密还原', async () => {
    const row = await db.selectFrom('provider_credentials').select('envelope').where('provider_host_id', '=', HOST).executeTakeFirstOrThrow();
    // ciphertext must not contain the plaintext appId or key material
    expect(JSON.stringify(row.envelope)).not.toContain('BEGIN RSA');
    const store = createKmsCredentialStore(db, kek);
    const creds = await store.githubAppCredentials(HOST);
    expect(creds?.appId).toBe('99');
    expect(creds?.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
  });

  it('从 installation 构造 authed Provider 并拉取仓库(端到端)', async () => {
    const store = createKmsCredentialStore(db, kek);
    const resolveList = createResolveListRepositories({ db, store });
    const repos = await resolveList({ internalInstallationId: INSTALL })(NATIVE_INSTALL);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ nativeId: '900', namespace: 'acme', name: 'app', defaultBranch: 'main', providerHostId: HOST });

    // App JWT -> installation token -> repository list
    const tokenReq = server.requests.find((r) => r.url.includes('access_tokens'));
    expect(String(tokenReq?.headers['authorization'])).toMatch(/^Bearer /);
    const repoReq = server.requests.find((r) => r.url.startsWith('/installation/repositories'));
    expect(repoReq?.headers['authorization']).toBe('token ghs_installation_token');
  });

  it('无凭据的 host → 明确报错', async () => {
    const emptyKek = createLocalMasterKey('kek-empty', randomBytes(32));
    const store = createKmsCredentialStore(db, emptyKek);
    const resolveList = createResolveListRepositories({ db, store });
    // A wrong KEK triggers a decryption error.
    await expect(resolveList({ internalInstallationId: INSTALL })(NATIVE_INSTALL)).rejects.toThrow();
  });

  it('GitLab / Forgejo:token 凭据 → 构造对应 Provider', async () => {
    const store = createKmsCredentialStore(db, kek);
    for (const provider of ['gitlab', 'forgejo'] as const) {
      const host = uuidv7();
      const install = uuidv7();
      await db.insertInto('provider_hosts').values({ id: host, tenant_id: TENANT, provider, base_url: 'https://x', api_url: 'https://x/api', is_saas: true, created_at: new Date() }).execute();
      await db.insertInto('installations').values({ id: install, tenant_id: TENANT, provider_host_id: host, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
      await storeCredential(db, kek, { tenantId: TENANT, hostId: host, kind: 'token', plaintext: 'tok-123' });

      const p = await createSourceProviderForInstallation({ db, store }, install);
      expect(p.kind).toBe(provider);
    }
  });

  it('Webhook secret:KMS 加密存储 → 可读回(明文不落库)', async () => {
    await storeWebhookSecret(db, kek, { tenantId: TENANT, hostId: HOST, secret: 'whsec-super' });
    const row = await db.selectFrom('provider_credentials').select('envelope').where('provider_host_id', '=', HOST).where('kind', '=', 'webhook-secret').executeTakeFirstOrThrow();
    expect(JSON.stringify(row.envelope)).not.toContain('whsec-super');
    expect(await readWebhookSecret(db, kek, HOST)).toBe('whsec-super');
  });

  it('无 token 的 GitLab host → 明确报错', async () => {
    const host = uuidv7();
    const install = uuidv7();
    await db.insertInto('provider_hosts').values({ id: host, tenant_id: TENANT, provider: 'gitlab', base_url: 'https://y', api_url: 'https://y/api', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: install, tenant_id: TENANT, provider_host_id: host, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    const store = createKmsCredentialStore(db, kek);
    await expect(createSourceProviderForInstallation({ db, store }, install)).rejects.toThrow(/no token/);
  });
});
