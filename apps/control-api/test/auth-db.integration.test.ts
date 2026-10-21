import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { resolveOrCreateUser, resolveSessionAuthContext } from '../src/auth-db.js';
import type { OAuthIdentity } from '../src/auth/oauth.js';

const GH = 'https://github.com';
const gh = (subject: string, extra: Partial<OAuthIdentity> = {}): OAuthIdentity => ({ provider: 'github', issuer: GH, subject, ...extra });

describe('OAuth 身份认人 + DB authz(用户系统 P1)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  const TENANT = uuidv7();
  const TENANT2 = uuidv7();
  const USER = uuidv7();

  const login = async (identity: OAuthIdentity, tenantId?: string) => {
    const userId = await resolveOrCreateUser(db, identity);
    return resolveSessionAuthContext(db, { userId, provider: identity.provider, issuer: identity.issuer, subject: identity.subject, ...(identity.login ? { login: identity.login } : {}) }, tenantId);
  };

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values([
        { id: TENANT, name: 'acme', region: null, created_at: new Date() },
        { id: TENANT2, name: 'beta', region: null, created_at: new Date() },
      ])
      .execute();
    await db.insertInto('users').values({ id: USER, email: 'owner@acme.io', display_name: 'Owner', created_at: new Date() }).execute();
    await db
      .insertInto('user_identities')
      .values({ id: uuidv7(), user_id: USER, kind: 'provider', issuer: GH, subject: '1001', login: 'owner', provider: 'github', tenant_id: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('memberships')
      .values({ id: uuidv7(), tenant_id: TENANT, user_id: USER, role: 'owner', status: 'active', created_at: new Date() })
      .execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  it('已知身份 + active membership → 解析角色/租户/scopes/userId;actorId = forge 数字 id', async () => {
    const ctx = await login(gh('1001', { login: 'owner' }));
    expect(ctx.role).toBe('owner');
    expect(ctx.tenantId).toBe(TENANT);
    expect(ctx.scopes).toContain('admin');
    expect(ctx.userId).toBe(USER);
    // Must equal the webhook actor (forge user id) or console confirmation mismatches.
    expect(ctx.actorId).toBe('1001');
    expect(ctx.identity).toMatchObject({ provider: 'github', issuer: GH, subject: '1001' });
  });

  it('JIT:未知身份 → 建 user + identity(幂等);无 membership → viewer', async () => {
    const ctx = await login(gh('2002', { email: 'new@x.io' }));
    expect(ctx.role).toBe('viewer');
    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.userId).toBeTruthy();
    const ctx2 = await login(gh('2002'));
    expect(ctx2.userId).toBe(ctx.userId);
    const idn = await db.selectFrom('user_identities').select('user_id').where('subject', '=', '2002').execute();
    expect(idn).toHaveLength(1);
  });

  it('login 改名不影响认人(按数字 id),但展示名会刷新', async () => {
    const first = await login(gh('3003', { login: 'old-name' }));
    const renamed = await login(gh('3003', { login: 'new-name' }));
    expect(renamed.userId).toBe(first.userId);
    const row = await db.selectFrom('user_identities').select('login').where('subject', '=', '3003').executeTakeFirstOrThrow();
    expect(row.login).toBe('new-name');
  });

  it('invited membership 不生效(仅 active)', async () => {
    const jit = await login(gh('2002'));
    await db
      .insertInto('memberships')
      .values({ id: uuidv7(), tenant_id: TENANT2, user_id: jit.userId!, role: 'admin', status: 'invited', created_at: new Date() })
      .execute();
    const after = await login(gh('2002'));
    expect(after.role).toBe('viewer');
    expect(after.tenantId).toBeUndefined();
  });

  it('多 active membership:无 X-Tenant → viewer(歧义);指定 tenant → 解析', async () => {
    await db
      .insertInto('memberships')
      .values({ id: uuidv7(), tenant_id: TENANT2, user_id: USER, role: 'member', status: 'active', created_at: new Date() })
      .execute();
    const ambiguous = await login(gh('1001'));
    expect(ambiguous.tenantId).toBeUndefined();
    expect(ambiguous.role).toBe('viewer');
    const chosen = await login(gh('1001'), TENANT2);
    expect(chosen.tenantId).toBe(TENANT2);
    expect(chosen.role).toBe('member');
  });

  it('webhook 安装者先落库 → 之后首次登录认到同一个用户(不开第二个号),占位邮箱被升级', async () => {
    const installerUser = uuidv7();
    const TENANT3 = uuidv7();
    await db.insertInto('tenants').values({ id: TENANT3, name: 'gamma', region: null, created_at: new Date() }).execute();
    await db.insertInto('users').values({ id: installerUser, email: 'github:someone@provider.local', display_name: null, created_at: new Date() }).execute();
    await db
      .insertInto('user_identities')
      .values({ id: uuidv7(), user_id: installerUser, kind: 'provider', issuer: GH, subject: '99887766', login: 'someone', provider: 'github', tenant_id: null, created_at: new Date() })
      .execute();
    await db.insertInto('memberships').values({ id: uuidv7(), tenant_id: TENANT3, user_id: installerUser, role: 'owner', status: 'active', created_at: new Date() }).execute();

    const before = Number((await db.selectFrom('users').select(db.fn.countAll().as('n')).executeTakeFirst())?.n ?? 0);
    const ctx = await login(gh('99887766', { login: 'someone', email: 'real@example.com' }), TENANT3);

    expect(ctx.userId).toBe(installerUser);
    expect(ctx.role).toBe('owner');
    expect(Number((await db.selectFrom('users').select(db.fn.countAll().as('n')).executeTakeFirst())?.n ?? 0)).toBe(before);
    const row = await db.selectFrom('users').select('email').where('id', '=', installerUser).executeTakeFirst();
    expect(row?.email).toBe('real@example.com'); // placeholder replaced
  });

  it('真实邮箱不被 forge 反向覆盖(只升级占位值)', async () => {
    const u = uuidv7();
    await db.insertInto('users').values({ id: u, email: 'chosen@example.com', display_name: null, created_at: new Date() }).execute();
    await db
      .insertInto('user_identities')
      .values({ id: uuidv7(), user_id: u, kind: 'provider', issuer: GH, subject: '4004', login: null, provider: 'github', tenant_id: null, created_at: new Date() })
      .execute();
    await login(gh('4004', { email: 'forge-says@example.com' }));
    const row = await db.selectFrom('users').select('email').where('id', '=', u).executeTakeFirst();
    expect(row?.email).toBe('chosen@example.com');
  });

  it('受信 issuer 的邮箱可合并到既有用户;不受信 issuer 一律开新号(防账号接管)', async () => {
    const u = uuidv7();
    await db.insertInto('users').values({ id: u, email: 'shared@example.com', display_name: null, created_at: new Date() }).execute();
    // github.com is trusted by default: same email -> existing user.
    const merged = await resolveOrCreateUser(db, gh('5005', { email: 'shared@example.com' }));
    expect(merged).toBe(u);

    // Self-hosted issuer with the same email -> not merged.
    const selfHosted: OAuthIdentity = { provider: 'forgejo', issuer: 'https://git.evil.test', subject: '1', email: 'shared@example.com' };
    const other = await resolveOrCreateUser(db, selfHosted);
    expect(other).not.toBe(u);
  });
});
