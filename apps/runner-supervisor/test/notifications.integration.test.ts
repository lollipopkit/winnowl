import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  createNotification,
  claimPendingEmailNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationRecipients,
  pendingEmailNotifications,
  markNotificationEmailed,
  renewNotificationEmailClaim,
  renderNotificationEmail,
} from '@reviewbot/notifications';
import {
  CROSS_TENANT_EVENT_MAX_ATTEMPTS,
  markCrossTenantEventConsumed,
  pendingCrossTenantEvents,
  recordCrossTenantEvent,
} from '@reviewbot/multi-repo';
import { createCrossTenantIntakeHandler } from '../src/cross-tenant-notify.js';
import { createNotificationEmailHandler } from '../src/notification-email.js';

const UP = uuidv7();
const DOWN = uuidv7();
const UP_REPO = uuidv7();
const DOWN_REPO = uuidv7();
const REL = uuidv7();

describe('站内通知 + 跨租户事件中转(0043)', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    for (const [tenant, repo, ns] of [
      [UP, UP_REPO, 'up'],
      [DOWN, DOWN_REPO, 'down'],
    ] as const) {
      const host = uuidv7();
      const install = uuidv7();
      await db
        .insertInto('tenants')
        .values({ id: tenant, name: ns, region: null, created_at: new Date() })
        .execute();
      await db
        .insertInto('provider_hosts')
        .values({
          id: host,
          tenant_id: tenant,
          provider: 'github',
          base_url: 'x',
          api_url: 'x',
          is_saas: true,
          created_at: new Date(),
        })
        .execute();
      await db
        .insertInto('installations')
        .values({
          id: install,
          tenant_id: tenant,
          provider_host_id: host,
          native_id: ns,
          account_login: ns,
          status: 'active',
          created_at: new Date(),
        })
        .execute();
      await db
        .insertInto('repositories')
        .values({
          id: repo,
          tenant_id: tenant,
          provider_host_id: host,
          installation_id: install,
          native_id: ns,
          namespace: ns,
          name: 'app',
          clone_url: 'x',
          default_branch: 'main',
          created_at: new Date(),
        })
        .execute();
    }
    await db
      .insertInto('cross_tenant_relationships')
      .values({
        id: REL,
        source_tenant_id: UP,
        source_repository_id: UP_REPO,
        target_tenant_id: DOWN,
        target_repository_id: DOWN_REPO,
        kind: 'library-dependent',
        status: 'active',
        proposed_by: null,
        decided_by: null,
        rationale: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  const record = (revId: string): Promise<string | null> =>
    recordCrossTenantEvent(db, {
      relationshipId: REL,
      sourceTenantId: UP,
      sourceRepositoryId: UP_REPO,
      targetTenantId: DOWN,
      targetRepositoryId: DOWN_REPO,
      kind: 'contract-change',
      sourceRevisionId: revId,
      payload: { contractPaths: ['openapi.yaml'] },
    });

  /** intake in the downstream tenant context (the runner wraps it in runWithTenant(job.tenantId)). */
  const intakeContext = () =>
    ({
      job: { tenantId: DOWN, payload: { tenantId: DOWN } },
      db,
      sandbox: {},
      signal: new AbortController().signal,
      log: () => undefined,
    }) as unknown as Parameters<ReturnType<typeof createCrossTenantIntakeHandler>>[0];

  it('上游记录事件 → 下游取得到;同一 revision 重复记为幂等(不刷屏)', async () => {
    const rev = uuidv7();
    expect(await record(rev)).toBeTruthy();
    expect(await record(rev)).toBeNull(); // a repeated upstream review adds no second record

    const pending = await pendingCrossTenantEvents(db, DOWN);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload.contractPaths).toEqual(['openapi.yaml']);
    // Upstream is not the target and sees none of these.
    expect(await pendingCrossTenantEvents(db, UP)).toHaveLength(0);
  });

  it('跨租户 payload 只保留有界的契约路径与 revision id', async () => {
    const rev = uuidv7();
    await recordCrossTenantEvent(db, {
      relationshipId: REL,
      sourceTenantId: UP,
      sourceRepositoryId: UP_REPO,
      targetTenantId: DOWN,
      targetRepositoryId: DOWN_REPO,
      kind: 'contract-change',
      sourceRevisionId: rev,
      payload: {
        contractPaths: ['openapi.yaml', 'openapi.yaml', '', 42],
        diff: 'private source code',
      },
    });
    const event = (await pendingCrossTenantEvents(db, DOWN)).find(
      (item) => item.payload.sourceRevisionId === rev,
    );
    expect(event?.payload).toEqual({ sourceRevisionId: rev, contractPaths: ['openapi.yaml'] });
  });

  it('事件端点或关系状态不一致时拒绝写入', async () => {
    await expect(
      recordCrossTenantEvent(db, {
        relationshipId: REL,
        sourceTenantId: UP,
        sourceRepositoryId: UP_REPO,
        targetTenantId: DOWN,
        targetRepositoryId: UP_REPO,
        kind: 'contract-change',
        sourceRevisionId: uuidv7(),
        payload: {},
      }),
    ).rejects.toThrow(/active relationship/);

    await db
      .updateTable('cross_tenant_relationships')
      .set({ status: 'revoked' })
      .where('id', '=', REL)
      .execute();
    await expect(record(uuidv7())).rejects.toThrow(/active relationship/);
    await db
      .updateTable('cross_tenant_relationships')
      .set({ status: 'active' })
      .where('id', '=', REL)
      .execute();
  });

  it('标记已消费后不再出现在待处理', async () => {
    const [ev] = await pendingCrossTenantEvents(db, DOWN);
    await markCrossTenantEventConsumed(db, ev!.id, DOWN);
    expect((await pendingCrossTenantEvents(db, DOWN)).some((event) => event.id === ev!.id)).toBe(
      false,
    );
  });

  it('关系撤销后,此前排队但尚未消费的事件不再投递', async () => {
    const eventId = await record(uuidv7());
    expect(eventId).toBeTruthy();
    await db
      .updateTable('cross_tenant_relationships')
      .set({ status: 'revoked' })
      .where('id', '=', REL)
      .execute();
    try {
      expect((await pendingCrossTenantEvents(db, DOWN)).some((event) => event.id === eventId)).toBe(
        false,
      );
    } finally {
      await db
        .updateTable('cross_tenant_relationships')
        .set({ status: 'active' })
        .where('id', '=', REL)
        .execute();
    }
  });

  it('通知 dedupeKey 幂等(周期 intake 重复扫到同一事件不会刷屏)', async () => {
    const key = `xtenant:${REL}:rev-1`;
    const a = await createNotification(db, {
      tenantId: DOWN,
      kind: 'cross-tenant-contract-change',
      title: '上游契约变更',
      body: 'b',
      dedupeKey: key,
    });
    const b = await createNotification(db, {
      tenantId: DOWN,
      kind: 'cross-tenant-contract-change',
      title: '上游契约变更',
      body: 'b',
      dedupeKey: key,
    });
    expect(b.id).toBe(a.id);
    const list = await listNotifications(db, DOWN);
    expect(list.items).toHaveLength(1);
    expect(list.unread).toBe(1);
  });

  it('通知 dedupeKey 在并发创建时仍只落一行', async () => {
    const key = `parallel:${uuidv7()}`;
    const rows = await Promise.all(
      Array.from({ length: 8 }, () =>
        createNotification(db, {
          tenantId: DOWN,
          kind: 'cross-tenant-contract-change',
          title: '并发',
          dedupeKey: key,
        }),
      ),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    const count = await db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', DOWN)
      .where((eb) => eb(eb.ref('payload', '->>').key('dedupeKey'), '=', key))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it('cross-tenant intake 绑定 job tenant,并发消费只写一条通知和审计', async () => {
    const rev = uuidv7();
    const eventId = await record(rev);
    expect(eventId).toBeTruthy();
    const handler = createCrossTenantIntakeHandler({
      buildProvider: async () => ({}) as never,
      createIssue: false,
    });
    await Promise.all([handler(intakeContext()), handler(intakeContext())]);

    expect(await pendingCrossTenantEvents(db, DOWN)).toHaveLength(0);
    const notifications = await db
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where((eb) => eb(eb.ref('payload', '->>').key('dedupeKey'), '=', `xtenant:${REL}:${rev}`))
      .executeTakeFirstOrThrow();
    expect(Number(notifications.n)).toBe(1);
    const audits = await db
      .selectFrom('audit_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('action', '=', 'cross-tenant.notified')
      .where((eb) => eb(eb.ref('detail', '->>').key('sourceRevisionId'), '=', rev))
      .executeTakeFirstOrThrow();
    expect(Number(audits.n)).toBe(1);

    // The job tenant differs from the payload: the whole run must not proceed.
    await expect(
      handler({ ...intakeContext(), job: { tenantId: UP, payload: { tenantId: DOWN } } }),
    ).rejects.toThrow(/tenantId/);
  });

  // Events are accounted individually: one failed delivery must not block later events of the tenant.
  it('一条事件投递失败不挡住后面的事件:失败的那条退避,其余照常投递', async () => {
    const firstRev = uuidv7();
    const secondRev = uuidv7();
    await record(firstRev);
    await record(secondRev);

    let issueAttempts = 0;
    const handler = createCrossTenantIntakeHandler({
      buildProvider: async () =>
        ({
          issues: {
            create: async () => {
              issueAttempts += 1;
              if (issueAttempts === 1) throw new Error('provider unavailable');
            },
          },
        }) as never,
    });
    // No throw: the failure is recorded on its event and the run finishes.
    await handler(intakeContext());
    expect(issueAttempts).toBe(2); // the second event is still delivered after the first fails

    expect(await pendingCrossTenantEvents(db, DOWN)).toHaveLength(0); // not picked up within the backoff window
    const later = await pendingCrossTenantEvents(db, DOWN, 50, new Date(Date.now() + 60 * 60_000));
    expect(later).toHaveLength(1); // pending again after the window, not dropped

    // Only the successful delivery is audited.
    const notified = await db
      .selectFrom('audit_events')
      .select((eb) => eb.ref('detail', '->>').key('sourceRevisionId').as('rev'))
      .where('action', '=', 'cross-tenant.notified')
      .where((eb) =>
        eb(eb.ref('detail', '->>').key('sourceRevisionId'), 'in', [firstRev, secondRev]),
      )
      .execute();
    expect(notified).toHaveLength(1);
  });

  it('反复失败到上限后放弃该事件,并站内告知租户(不再无限重试)', async () => {
    const rev = uuidv7();
    const eventId = await record(rev);
    expect(eventId).toBeTruthy();
    const failing = createCrossTenantIntakeHandler({
      buildProvider: async () =>
        ({
          issues: { create: async () => Promise.reject(new Error('issues are disabled')) },
        }) as never,
    });
    for (let attempt = 1; attempt <= CROSS_TENANT_EVENT_MAX_ATTEMPTS; attempt += 1) {
      // Move the backoff window into the past to simulate the next intake run.
      await db
        .updateTable('cross_tenant_events')
        .set({ next_attempt_at: new Date(0) })
        .where('id', '=', eventId!)
        .execute();
      await failing(intakeContext());
    }

    const row = await db
      .selectFrom('cross_tenant_events')
      .select(['attempt_count', 'next_attempt_at', 'failed_at'])
      .where('id', '=', eventId!)
      .executeTakeFirstOrThrow();
    expect(row.attempt_count).toBe(CROSS_TENANT_EVENT_MAX_ATTEMPTS);
    expect(row.failed_at).not.toBeNull();
    expect(row.next_attempt_at).toBeNull();
    expect((await pendingCrossTenantEvents(db, DOWN)).some((event) => event.id === eventId)).toBe(
      false,
    );

    // Giving up must be reported, or the user waits forever for an issue.
    const told = await db
      .selectFrom('notifications')
      .select('id')
      .where('tenant_id', '=', DOWN)
      .where('kind', '=', 'cross-tenant-contract-change-undeliverable')
      .where((eb) =>
        eb(
          eb.ref('payload', '->>').key('dedupeKey'),
          '=',
          `xtenant-undeliverable:${REL}:${eventId}`,
        ),
      )
      .execute();
    expect(told).toHaveLength(1);
  });

  it('已读流转:单条 → 幂等;全部已读 → 未读归零', async () => {
    const tenantId = uuidv7();
    await db
      .insertInto('tenants')
      .values({ id: tenantId, name: `read-${tenantId}`, region: null, created_at: new Date() })
      .execute();
    await createNotification(db, {
      tenantId,
      kind: 'quota-warning',
      title: '配额',
      body: '',
    });
    await createNotification(db, {
      tenantId,
      kind: 'review-completed',
      title: '审阅完成',
      body: '',
    });
    let list = await listNotifications(db, tenantId);
    expect(list.unread).toBe(2);

    const first = list.items[0]!;
    expect(await markNotificationRead(db, tenantId, first.id)).toBe(true);
    expect(await markNotificationRead(db, tenantId, first.id)).toBe(false); // already read → false

    expect(await markAllNotificationsRead(db, tenantId)).toBe(1);
    list = await listNotifications(db, tenantId);
    expect(list.unread).toBe(0);
  });

  it('通知严格租户隔离:上游看不到下游的通知', async () => {
    expect((await listNotifications(db, UP)).items).toHaveLength(0);
  });

  it('邮件:待发列表 → 标记已发后不再出现;失败不标记即可下轮重试', async () => {
    const n = await createNotification(db, {
      tenantId: DOWN,
      kind: 'review-completed',
      title: '标题',
      body: '正文',
      link: '/reviews',
    });
    const pending = await pendingEmailNotifications(db, DOWN);
    expect(pending.map((p) => p.id)).toContain(n.id);

    // Simulated delivery failure: without markNotificationEmailed it stays pending.
    expect((await pendingEmailNotifications(db, DOWN)).map((p) => p.id)).toContain(n.id);

    const claimToken = uuidv7();
    expect(
      (await claimPendingEmailNotifications(db, DOWN, claimToken)).some((item) => item.id === n.id),
    ).toBe(true);
    expect(await markNotificationEmailed(db, UP, n.id, claimToken)).toBe(false);
    expect(await markNotificationEmailed(db, DOWN, n.id, uuidv7())).toBe(false);
    expect(await renewNotificationEmailClaim(db, DOWN, n.id, claimToken, 60)).toBe(true);
    expect(await markNotificationEmailed(db, DOWN, n.id, claimToken)).toBe(true);
    expect((await pendingEmailNotifications(db, DOWN)).map((p) => p.id)).not.toContain(n.id);
  });

  it('并发 notification_email handler 对同一通知只发送一次', async () => {
    const tenantId = uuidv7();
    const userId = uuidv7();
    await db
      .insertInto('tenants')
      .values({ id: tenantId, name: `mail-${tenantId}`, region: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('users')
      .values({ id: userId, email: `mail-${userId}@example.com`, created_at: new Date() })
      .execute();
    await db
      .insertInto('memberships')
      .values({
        id: uuidv7(),
        tenant_id: tenantId,
        user_id: userId,
        role: 'owner',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await createNotification(db, {
      tenantId,
      kind: 'review-completed',
      title: 'only-once',
    });
    const sent: {
      subject: string;
      messageId?: string;
      to: string | string[];
      bcc?: string | string[];
    }[] = [];
    const handler = createNotificationEmailHandler({
      mailer: async ({ subject, messageId, to, bcc }) => {
        sent.push({ subject, messageId, to, bcc });
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    const context = {
      job: { tenantId, payload: { tenantId } },
      db,
      sandbox: {},
      signal: new AbortController().signal,
      log: () => undefined,
    } as unknown as Parameters<typeof handler>[0];
    await Promise.all([handler(context), handler(context)]);
    const delivered = sent.filter(({ subject }) => subject.includes('only-once'));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.messageId).toMatch(/^<notification-.*@winnowl\.local>$/);
    expect(delivered[0]?.to).toBe('undisclosed-recipients:;');
    expect(delivered[0]?.bcc).toEqual([`mail-${userId}@example.com`]);
  });

  // Once sent, the email must be marked: a failed mark is retried, never released,
  // since releasing the claim would send the email again.
  it('发送成功后标记失败 → 重试标记,而不是退掉 claim 再发一遍', async () => {
    const tenantId = uuidv7();
    const userId = uuidv7();
    await db
      .insertInto('tenants')
      .values({ id: tenantId, name: `mark-${tenantId}`, region: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('users')
      .values({ id: userId, email: `mark-${userId}@example.com`, created_at: new Date() })
      .execute();
    await db
      .insertInto('memberships')
      .values({
        id: uuidv7(),
        tenant_id: tenantId,
        user_id: userId,
        role: 'owner',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await createNotification(db, { tenantId, kind: 'review-completed', title: 'mark-retry' });

    // Every notifications write throws (marking and lease renewal both use it).
    const failingMarks = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'updateTable') {
          return (table: string) => {
            const qb = target.updateTable(table as never);
            if (table !== 'notifications') return qb;
            return new Proxy(qb as object, {
              get(q, p) {
                if (p === 'executeTakeFirst' || p === 'execute') {
                  return async () => {
                    throw new Error('db is down');
                  };
                }
                const v = Reflect.get(q, p, q);
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(q) : v;
              },
            });
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Db;

    const sent: string[] = [];
    const handler = createNotificationEmailHandler({ mailer: async () => void sent.push('sent') });
    await handler({
      job: { tenantId, payload: { tenantId } },
      db: failingMarks,
      sandbox: {},
      signal: new AbortController().signal,
      log: () => undefined,
    } as unknown as Parameters<typeof handler>[0]);

    expect(sent).toEqual(['sent']);
    // The claim was not released: still inside the claim window, so not pending.
    expect((await pendingEmailNotifications(db, tenantId)).map((p) => p.title)).not.toContain(
      'mark-retry',
    );
  });

  it('notification_email 取消时立即释放尚未发送的整批 claim', async () => {
    const tenantId = uuidv7();
    const userId = uuidv7();
    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        name: `abort-mail-${tenantId}`,
        region: null,
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('users')
      .values({ id: userId, email: `abort-${userId}@example.com`, created_at: new Date() })
      .execute();
    await db
      .insertInto('memberships')
      .values({
        id: uuidv7(),
        tenant_id: tenantId,
        user_id: userId,
        role: 'owner',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    const first = await createNotification(db, {
      tenantId,
      kind: 'review-completed',
      title: 'first-aborted',
    });
    const second = await createNotification(db, {
      tenantId,
      kind: 'review-completed',
      title: 'second-aborted',
    });
    const controller = new AbortController();
    controller.abort();
    const handler = createNotificationEmailHandler({ mailer: async () => undefined });
    // Stopped means unfinished: throw (a normal return is recorded as completed) and release the batch claims.
    await expect(
      handler({
        job: { tenantId, payload: { tenantId } },
        db,
        sandbox: {},
        signal: controller.signal,
        log: () => undefined,
      } as unknown as Parameters<typeof handler>[0]),
    ).rejects.toThrow(/interrupted/);

    const reclaimed = await claimPendingEmailNotifications(db, tenantId, uuidv7());
    expect(reclaimed.map((item) => item.id)).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it('收件人:只取 active 的 owner/admin,且过滤 provider 占位邮箱(发不出去)', async () => {
    const real = uuidv7();
    const placeholder = uuidv7();
    const viewer = uuidv7();
    await db
      .insertInto('users')
      .values({ id: real, email: 'ops@example.com', created_at: new Date() })
      .execute();
    await db
      .insertInto('users')
      .values({ id: placeholder, email: 'github:bot@provider.local', created_at: new Date() })
      .execute();
    await db
      .insertInto('users')
      .values({ id: viewer, email: 'viewer@example.com', created_at: new Date() })
      .execute();
    await db
      .insertInto('memberships')
      .values({
        id: uuidv7(),
        tenant_id: DOWN,
        user_id: real,
        role: 'owner',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('memberships')
      .values({
        id: uuidv7(),
        tenant_id: DOWN,
        user_id: placeholder,
        role: 'admin',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('memberships')
      .values({
        id: uuidv7(),
        tenant_id: DOWN,
        user_id: viewer,
        role: 'viewer',
        status: 'active',
        created_at: new Date(),
      })
      .execute();

    expect(await notificationRecipients(db, DOWN)).toEqual(['ops@example.com']);
  });

  it('邮件正文:相对 link 拼成绝对地址', () => {
    const { subject, text } = renderNotificationEmail(
      { kind: 'k', title: '标题', body: '正文', link: '/reviews' },
      'https://winnowl.lollipopkit.com/',
    );
    expect(subject).toContain('标题');
    expect(text).toContain('正文');
    expect(text).toContain('https://winnowl.lollipopkit.com/reviews');
  });
});
