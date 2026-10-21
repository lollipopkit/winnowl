import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { buildAdapters, createDbContextResolver } from '../src/context.js';
import { WebhookIngestor } from '../src/ingestor.js';
import { createGithubTenantProvisioner } from '../src/provision.js';
import type { IngestInput } from '../src/types.js';

const APP_SECRET = 'app-level-secret';

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function installationCreatedBody(installationId: number, account = 'new-org'): string {
  return JSON.stringify({
    action: 'created',
    installation: { id: installationId, account: { login: account } },
    sender: { id: 4242, login: 'installer-user', type: 'User' },
  });
}

function input(body: string, deliveryId: string, signature = sign(body), event = 'installation'): IngestInput {
  return {
    provider: 'github',
    headers: {
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature,
      'content-type': 'application/json',
    },
    body,
    receivedAt: '2026-07-18T00:00:00.000Z',
  };
}

describe('租户自动开通(用户系统 P3:installation.created → provisionTenant)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let ingestor: WebhookIngestor;

  beforeAll(async () => {
    // Allowlist the test account; admission rejection is covered at the end of the file.
    process.env.TENANT_PROVISION_ALLOWLIST = 'new-org';
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    ingestor = new WebhookIngestor({
      db,
      adapters: buildAdapters(),
      resolveContext: createDbContextResolver(db),
      resolveSecret: async () => APP_SECRET,
      provision: createGithubTenantProvisioner(db, () => APP_SECRET),
    });
  });

  afterAll(async () => {
    await stop?.();
  });

  it('未知 installation 的 installation.created(验签通过)→ 开通租户并 accepted;触发 sync_installation', async () => {
    const body = installationCreatedBody(777001);
    const result = await ingestor.handle(input(body, 'prov-1'));
    expect(result.status).toBe('accepted');

    const install = await db
      .selectFrom('installations')
      .selectAll()
      .where('native_id', '=', '777001')
      .executeTakeFirstOrThrow();
    expect(install.account_login).toBe('new-org');

    const identity = await db
      .selectFrom('user_identities')
      .selectAll()
      .where('kind', '=', 'provider')
      // issuer is the host origin, not the provider name.
      .where('issuer', '=', 'https://github.com')
      .where('subject', '=', '4242')
      .executeTakeFirstOrThrow();
    const membership = await db
      .selectFrom('memberships')
      .selectAll()
      .where('tenant_id', '=', install.tenant_id)
      .where('user_id', '=', identity.user_id)
      .executeTakeFirstOrThrow();
    expect(membership.role).toBe('owner');
    expect(identity.provider).toBe('github');
    const sub = await db.selectFrom('subscriptions').selectAll().where('tenant_id', '=', install.tenant_id).executeTakeFirst();
    expect(sub?.status).toBe('active');

    const sync = await db.selectFrom('jobs').selectAll().where('type', '=', 'sync_installation').execute();
    expect(sync.some((j) => (j.payload as { installationNativeId?: string }).installationNativeId === '777001')).toBe(true);
  });

  it('fail-closed:验签失败不开通(unresolved,零落库)', async () => {
    const body = installationCreatedBody(777002);
    const result = await ingestor.handle(input(body, 'prov-2', sign(body, 'wrong-secret')));
    expect(result.status).toBe('unresolved');
    const install = await db.selectFrom('installations').selectAll().where('native_id', '=', '777002').executeTakeFirst();
    expect(install).toBeUndefined();
  });

  it('fail-closed:App secret 未配置不开通', async () => {
    const noSecret = new WebhookIngestor({
      db,
      adapters: buildAdapters(),
      resolveContext: createDbContextResolver(db),
      resolveSecret: async () => APP_SECRET,
      provision: createGithubTenantProvisioner(db, () => undefined),
    });
    const body = installationCreatedBody(777003);
    const result = await noSecret.handle(input(body, 'prov-3'));
    expect(result.status).toBe('unresolved');
  });

  it('幂等:重复 installation.created 不再新建租户(context 已命中,provision 不触发)', async () => {
    const body = installationCreatedBody(777001);
    const result = await ingestor.handle(input(body, 'prov-4'));
    expect(result.status).toBe('accepted');
    const tenants = await db
      .selectFrom('installations')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('native_id', '=', '777001')
      .executeTakeFirstOrThrow();
    expect(Number(tenants.n)).toBe(1);
  });

  it('已知 GitHub installation 的 form-encoded delivery 可解析上下文', async () => {
    const json = installationCreatedBody(777001);
    const body = `payload=${encodeURIComponent(json)}`;
    const result = await ingestor.handle({
      provider: 'github',
      headers: {
        'X-GitHub-Event': 'installation',
        'X-GitHub-Delivery': 'prov-form',
        'X-Hub-Signature-256': sign(body),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      receivedAt: '2026-07-18T00:00:00.000Z',
    });
    expect(result.status).toBe('accepted');
  });

  it('recovers a still-installed App from installation_repositories (platform lost the installation)', async () => {
    const body = JSON.stringify({
      action: 'added',
      installation: { id: 777020, account: { login: 'new-org' } },
      repositories_added: [{ id: 1, full_name: 'new-org/app' }],
      sender: { id: 4243, login: 'repo-admin', type: 'User' },
    });
    const result = await ingestor.handle(input(body, 'prov-repos-1', sign(body), 'installation_repositories'));
    expect(result.status).toBe('accepted');
    const install = await db.selectFrom('installations').selectAll().where('native_id', '=', '777020').executeTakeFirstOrThrow();
    expect(install.account_login).toBe('new-org');
    // A forged one is still refused: same App-level signature check.
    const forged = body.replace('777020', '777021');
    const refused = await ingestor.handle(input(forged, 'prov-repos-2', sign(forged, 'wrong-secret'), 'installation_repositories'));
    expect(refused.status).toBe('unresolved');
  });

  it('非 installation.created 的未知事件维持 unresolved', async () => {
    const body = JSON.stringify({ action: 'deleted', installation: { id: 777004, account: { login: 'x' } }, sender: { id: 1, login: 'y' } });
    const result = await ingestor.handle(input(body, 'prov-5'));
    expect(result.status).toBe('unresolved');
  });

  it('0044 准入:名单外的账号**不开通**,只落一条 pending_installations 待批(不是静默丢弃)', async () => {
    const prev = process.env.TENANT_PROVISION_ALLOWLIST;
    process.env.TENANT_PROVISION_ALLOWLIST = 'only-this-org';
    try {
      const body = installationCreatedBody(777009, 'stranger-org');
      const result = await ingestor.handle(input(body, 'prov-admission-1'));
      expect(result.status).toBe('unresolved');
      expect(await db.selectFrom('installations').selectAll().where('native_id', '=', '777009').executeTakeFirst()).toBeUndefined();

      const pending = await db.selectFrom('pending_installations').selectAll().where('installation_native_id', '=', '777009').executeTakeFirstOrThrow();
      expect(pending.account_login).toBe('stranger-org');
      expect(pending.status).toBe('pending');

      // Redelivery is idempotent.
      await ingestor.handle(input(body, 'prov-admission-2'));
      const rows = await db.selectFrom('pending_installations').selectAll().where('installation_native_id', '=', '777009').execute();
      expect(rows).toHaveLength(1);
    } finally {
      process.env.TENANT_PROVISION_ALLOWLIST = prev;
    }
  });

  it('0044 准入:closed 连待批都不记(彻底关闭)', async () => {
    const prevMode = process.env.TENANT_PROVISION_MODE;
    process.env.TENANT_PROVISION_MODE = 'closed';
    try {
      await ingestor.handle(input(installationCreatedBody(777010, 'nope-org'), 'prov-admission-3'));
      expect(await db.selectFrom('pending_installations').selectAll().where('installation_native_id', '=', '777010').executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('installations').selectAll().where('native_id', '=', '777010').executeTakeFirst()).toBeUndefined();
    } finally {
      process.env.TENANT_PROVISION_MODE = prevMode;
    }
  });
});
