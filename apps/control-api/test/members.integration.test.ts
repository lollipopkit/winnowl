import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { AuthContext } from '../src/rbac.js';

const TENANT = uuidv7();
const OWNER = uuidv7();
const BOB = uuidv7();

describe('成员/邀请(用户系统 P2)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let owner: FastifyInstance; // owner(member:manage)
  let viewer: FastifyInstance; // no member:manage
  let bob: FastifyInstance; // invitee: authenticated, no tenant yet
  let inviteToken = '';

  const build = (auth: AuthContext) =>
    buildServer({ quiet: true, db, rbac: { resolveAuth: () => auth } });

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('users')
      .values([
        { id: OWNER, email: 'owner@acme.io', display_name: 'Owner', created_at: new Date() },
        { id: BOB, email: 'bob@x.io', display_name: 'Bob', created_at: new Date() },
      ])
      .execute();
    await db
      .insertInto('memberships')
      .values({
        id: uuidv7(),
        tenant_id: TENANT,
        user_id: OWNER,
        role: 'owner',
        status: 'active',
        created_at: new Date(),
      })
      .execute();

    owner = await build({
      role: 'owner',
      scopes: ['admin'],
      tenantId: TENANT,
      actorId: 'owner-sub',
      userId: OWNER,
    });
    viewer = await build({
      role: 'viewer',
      scopes: [],
      tenantId: TENANT,
      actorId: 'v-sub',
      userId: uuidv7(),
    });
    bob = await build({ role: 'viewer', scopes: [], actorId: 'bob-sub', userId: BOB });
    await Promise.all([owner.ready(), viewer.ready(), bob.ready()]);
  });

  afterAll(async () => {
    await Promise.all([owner?.close(), viewer?.close(), bob?.close()]);
    await stop?.();
  });

  it('owner 列成员(初始仅 owner)+ 邀请 bob', async () => {
    const list = await owner.inject({ method: 'GET', url: '/v1/members' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    const inv = await owner.inject({
      method: 'POST',
      url: '/v1/members/invite',
      payload: { email: 'bob@x.io', role: 'member' },
    });
    expect(inv.statusCode).toBe(201);
    inviteToken = (inv.json() as { token: string }).token;
    expect(inviteToken).toBeTruthy();
    const pend = await owner.inject({ method: 'GET', url: '/v1/invites' });
    expect(pend.json()).toHaveLength(1);
  });

  it('viewer 无 member:manage → 403', async () => {
    expect((await viewer.inject({ method: 'GET', url: '/v1/members' })).statusCode).toBe(403);
    expect(
      (
        await viewer.inject({
          method: 'POST',
          url: '/v1/members/invite',
          payload: { email: 'x@y.io', role: 'member' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('bob accept 邀请 → active membership(member);重复 accept → 404', async () => {
    const r = await bob.inject({ method: 'POST', url: `/v1/invites/${inviteToken}/accept` });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { tenantId: string }).tenantId).toBe(TENANT);
    const m = await db
      .selectFrom('memberships')
      .select(['role', 'status'])
      .where('tenant_id', '=', TENANT)
      .where('user_id', '=', BOB)
      .executeTakeFirst();
    expect(m).toMatchObject({ role: 'member', status: 'active' });
    expect(
      (await bob.inject({ method: 'POST', url: `/v1/invites/${inviteToken}/accept` })).statusCode,
    ).toBe(404);
  });

  it('owner 改 bob 角色 + 移除', async () => {
    expect(
      (
        await owner.inject({
          method: 'POST',
          url: `/v1/members/${BOB}/role`,
          payload: { role: 'admin' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await owner.inject({ method: 'DELETE', url: `/v1/members/${BOB}` })).statusCode).toBe(
      200,
    );
    const gone = await db
      .selectFrom('memberships')
      .select('id')
      .where('user_id', '=', BOB)
      .where('tenant_id', '=', TENANT)
      .executeTakeFirst();
    expect(gone).toBeUndefined();
  });

  it('不能移除最后一个 owner', async () => {
    expect((await owner.inject({ method: 'DELETE', url: `/v1/members/${OWNER}` })).statusCode).toBe(
      409,
    );
  });

  it('邀请邮件(ADR-014):配置 mailer → 发送 accept 链接 + emailSent=true;无 mailer → emailSent=false', async () => {
    // No mailer: emailSent=false, token returned.
    const noMail = await owner.inject({
      method: 'POST',
      url: '/v1/members/invite',
      payload: { email: 'nomail@x.io', role: 'viewer' },
    });
    expect((noMail.json() as { emailSent: boolean; token: string }).emailSent).toBe(false);

    // Fake mailer + consoleBaseUrl: email has the accept link and tenant name.
    const sent: { to: string; subject: string; text: string }[] = [];
    const withMail = await buildServer({
      quiet: true,
      db,
      rbac: {
        resolveAuth: () => ({
          role: 'owner',
          scopes: ['admin'] as never,
          tenantId: TENANT,
          actorId: 'owner-sub',
          userId: OWNER,
        }),
      },
      mailer: async (m) => {
        sent.push(m);
      },
      consoleBaseUrl: 'https://console.example',
    });
    await withMail.ready();
    try {
      const r = await withMail.inject({
        method: 'POST',
        url: '/v1/members/invite',
        payload: { email: 'mailed@x.io', role: 'member' },
      });
      const body = r.json() as { emailSent: boolean; token: string };
      expect(body.emailSent).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe('mailed@x.io');
      expect(sent[0]!.subject).toContain('acme');
      expect(sent[0]!.subject).toContain('invited'); // English by default
      expect(sent[0]!.text).toContain(`https://console.example/invites/${body.token}`);

      // locale=zh -> Chinese email; unknown locales fall back to English.
      const zh = await withMail.inject({
        method: 'POST',
        url: '/v1/members/invite',
        payload: { email: 'zh@x.io', role: 'member', locale: 'zh' },
      });
      expect(zh.statusCode).toBe(201);
      expect(sent[1]!.subject).toContain('邀请你加入 acme');
      expect(sent[1]!.text).toContain('点击链接接受邀请');
      const zhHant = await withMail.inject({
        method: 'POST',
        url: '/v1/members/invite',
        payload: { email: 'zh-hant@x.io', role: 'member', locale: 'zh-Hant' },
      });
      expect(zhHant.statusCode).toBe(201);
      // Control API currently has en/zh mail dictionaries only. Traditional Chinese must not be
      // silently rendered with the Simplified dictionary; unsupported canonical locales use en.
      expect(sent[2]!.subject).toContain('invited');
      const fr = await withMail.inject({
        method: 'POST',
        url: '/v1/members/invite',
        payload: { email: 'fr-fr@x.io', role: 'member', locale: 'fr-FR' },
      });
      expect(fr.statusCode).toBe(201);
      expect(sent[3]!.subject).toContain('invited');
      const xx = await withMail.inject({
        method: 'POST',
        url: '/v1/members/invite',
        payload: { email: 'xx@x.io', role: 'member', locale: 'xx' },
      });
      expect(xx.statusCode).toBe(201);
      expect(sent[4]!.subject).toContain('invited');
    } finally {
      await withMail.close();
    }

    // Mailer throws: invite still created (201), emailSent=false.
    const failing = await buildServer({
      quiet: true,
      db,
      rbac: {
        resolveAuth: () => ({
          role: 'owner',
          scopes: ['admin'] as never,
          tenantId: TENANT,
          actorId: 'owner-sub',
          userId: OWNER,
        }),
      },
      mailer: async () => {
        throw new Error('smtp down');
      },
    });
    await failing.ready();
    try {
      const r = await failing.inject({
        method: 'POST',
        url: '/v1/members/invite',
        payload: { email: 'fail@x.io', role: 'member' },
      });
      expect(r.statusCode).toBe(201);
      const body = r.json() as { emailSent: boolean; token: string };
      expect(body.emailSent).toBe(false);
      expect(body.token).toBeTruthy();
    } finally {
      await failing.close();
    }
  });
});
