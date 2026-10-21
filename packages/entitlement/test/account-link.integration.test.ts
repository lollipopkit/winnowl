import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { providerIssuer } from '@reviewbot/domain';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { listIdentities, mergeUsers, provisionTenant, unlinkIdentity } from '../src/index.js';

describe('账号关联:多 forge 身份统一(0047)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  const T1 = uuidv7();
  const T2 = uuidv7();

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values([
      { id: T1, name: 'acme', region: null, created_at: new Date() },
      { id: T2, name: 'globex', region: null, created_at: new Date() },
    ]).execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  beforeEach(async () => {
    await db.deleteFrom('users').execute();
  });

  async function mkUser(email: string, identities: { kind: 'oidc' | 'provider'; issuer: string; subject: string; provider?: string }[]): Promise<string> {
    const id = uuidv7();
    await db.insertInto('users').values({ id, email, display_name: null, created_at: new Date() }).execute();
    for (const i of identities) {
      await db.insertInto('user_identities').values({
        id: uuidv7(), user_id: id, kind: i.kind, issuer: i.issuer, subject: i.subject,
        login: null, provider: i.provider ?? null, tenant_id: null, created_at: new Date(),
      }).execute();
    }
    return id;
  }

  it('**自建实例同号用户不是同一个人** —— 这正是 0047 要修的接管面', async () => {
    // Both hosts have user id "1". Keyed by provider name they would collapse into one identity,
    // letting an attacker's instance log in as the victim.
    const victim = await mkUser('victim@acme.io', [
      { kind: 'provider', issuer: providerIssuer('forgejo', 'https://git.acme.com'), subject: '1', provider: 'forgejo' },
    ]);
    const attacker = await mkUser('attacker@evil.io', [
      { kind: 'provider', issuer: providerIssuer('forgejo', 'https://git.evil.com'), subject: '1', provider: 'forgejo' },
    ]);
    expect(victim).not.toBe(attacker);

    const rows = await db.selectFrom('user_identities').select(['issuer', 'user_id']).where('subject', '=', '1').execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.issuer)).size).toBe(2);
  });

  it('issuer 归一化:大小写/末尾斜杠/路径不影响定位(否则同一台 host 会被算成两个)', () => {
    expect(providerIssuer('forgejo', 'https://Git.ACME.com/')).toBe('https://git.acme.com');
    expect(providerIssuer('forgejo', 'https://git.acme.com/api/v1')).toBe('https://git.acme.com');
    expect(providerIssuer('github')).toBe('https://github.com');
    // Self-hosted without base_url must throw rather than invent an issuer.
    expect(() => providerIssuer('forgejo')).toThrow(/base_url/);
  });

  it('合并:身份/成员资格搬到 winner,loser 用户行消失', async () => {
    const a = await mkUser('a@x.io', [{ kind: 'provider', issuer: 'https://github.com', subject: '100', provider: 'github' }]);
    const b = await mkUser('b@y.io', [{ kind: 'provider', issuer: 'https://git.acme.com', subject: '7', provider: 'forgejo' }]);
    await db.insertInto('memberships').values([
      { id: uuidv7(), tenant_id: T1, user_id: a, role: 'admin', status: 'active', created_at: new Date() },
      { id: uuidv7(), tenant_id: T2, user_id: b, role: 'member', status: 'active', created_at: new Date() },
    ]).execute();

    const r = await mergeUsers(db, a, b);
    expect(r.identitiesMoved).toBe(1);
    expect(r.membershipsMoved).toBe(1);
    expect(await db.selectFrom('users').select('id').where('id', '=', b).executeTakeFirst()).toBeUndefined();

    const ids = await listIdentities(db, a);
    expect(ids.map((i) => i.issuer).sort()).toEqual(['https://git.acme.com', 'https://github.com']);
    expect(ids.find((i) => i.provider === 'forgejo')?.subject).toBe('7');
    const ms = await db.selectFrom('memberships').select(['tenant_id', 'role']).where('user_id', '=', a).execute();
    expect(ms).toHaveLength(2);
  });

  it('同租户两边都有成员资格 → **保留更高角色**,不降级也不重复', async () => {
    const a = await mkUser('a@x.io', [{ kind: 'oidc', issuer: 'https://kc/realms/w', subject: 'sa' }]);
    const b = await mkUser('b@y.io', [{ kind: 'oidc', issuer: 'https://kc/realms/w', subject: 'sb' }]);
    await db.insertInto('memberships').values([
      { id: uuidv7(), tenant_id: T1, user_id: a, role: 'member', status: 'active', created_at: new Date() },
      { id: uuidv7(), tenant_id: T1, user_id: b, role: 'owner', status: 'active', created_at: new Date() },
    ]).execute();

    const r = await mergeUsers(db, a, b);
    expect(r.membershipsMerged).toBe(1);
    const ms = await db.selectFrom('memberships').select('role').where('user_id', '=', a).execute();
    expect(ms).toHaveLength(1);
    expect(ms[0]!.role).toBe('owner'); // merging keeps the higher role
  });

  it('user 级凭据撞车 → **丢弃 loser 的**,不把别人的 key 挪到自己名下', async () => {
    const a = await mkUser('a@x.io', [{ kind: 'oidc', issuer: 'https://kc/realms/w', subject: 'sa' }]);
    const b = await mkUser('b@y.io', [{ kind: 'oidc', issuer: 'https://kc/realms/w', subject: 'sb' }]);
    const cred = (userId: string, service: string) => ({
      id: uuidv7(), tenant_id: T1, repository_id: null, user_id: userId, service,
      envelope: JSON.stringify({ v: userId }) as unknown as Record<string, unknown>,
      created_at: new Date(), updated_at: new Date(),
    });
    await db.insertInto('service_credentials').values([cred(a, 'llm'), cred(b, 'llm'), cred(b, 'exa')]).execute();

    const r = await mergeUsers(db, a, b);
    expect(r.credentialsDropped).toBe(1); // conflicting llm
    expect(r.credentialsMoved).toBe(1); // non-conflicting exa
    const kept = await db.selectFrom('service_credentials').select(['service', 'envelope']).where('user_id', '=', a).orderBy('service').execute();
    expect(kept.map((k) => k.service)).toEqual(['exa', 'llm']);
    expect((kept.find((k) => k.service === 'llm')!.envelope as { v: string }).v).toBe(a); // winner's own key kept
  });

  it('合并自己 → 拒绝;合并不存在的用户 → 拒绝(且不留半成品)', async () => {
    const a = await mkUser('a@x.io', [{ kind: 'oidc', issuer: 'https://kc/realms/w', subject: 'sa' }]);
    await expect(mergeUsers(db, a, a)).rejects.toThrow(/自己/);
    await expect(mergeUsers(db, a, uuidv7())).rejects.toThrow(/不存在/);
    expect(await listIdentities(db, a)).toHaveLength(1);
  });

  it('解绑保留至少一条 —— 解到零条等于把自己锁在门外', async () => {
    const a = await mkUser('a@x.io', [
      { kind: 'oidc', issuer: 'https://kc/realms/w', subject: 'sa' },
      { kind: 'provider', issuer: 'https://github.com', subject: '100', provider: 'github' },
    ]);
    const ids = await listIdentities(db, a);
    expect(await unlinkIdentity(db, a, ids[0]!.id)).toEqual({ ok: true });
    const left = await listIdentities(db, a);
    expect(left).toHaveLength(1);
    expect(await unlinkIdentity(db, a, left[0]!.id)).toEqual({ ok: false, reason: 'last_identity' });
    expect(await listIdentities(db, a)).toHaveLength(1);

    // Someone else's identity -> not_found, without revealing that it exists.
    const b = await mkUser('b@y.io', [{ kind: 'oidc', issuer: 'https://kc/realms/w', subject: 'sb' }]);
    const bIds = await listIdentities(db, b);
    expect(await unlinkIdentity(db, a, bIds[0]!.id)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('provisionTenant 的安装者身份按 host 落库(不是 provider 名)', async () => {
    const r = await provisionTenant(db, {
      provider: 'forgejo',
      host: { baseUrl: 'https://git.acme.com', apiUrl: 'https://git.acme.com/api/v1', isSaas: false },
      installationNativeId: 'inst-1',
      accountLogin: 'acme',
      installer: { providerUserId: '42', login: 'bob' },
    });
    const idn = await db.selectFrom('user_identities').select(['issuer', 'provider']).where('subject', '=', '42').executeTakeFirstOrThrow();
    expect(idn.issuer).toBe('https://git.acme.com');
    expect(idn.provider).toBe('forgejo');
    expect(r.created).toBe(true);
  });
});
