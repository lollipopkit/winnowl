import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  claimActionPlanExecution,
  completeActionPlanExecution,
  confirmActionPlan,
  insertActionPlan,
  listActionPlans,
  loadActionPlan,
  type ActionPlan,
} from '../src/index.js';

const TENANT = uuidv7();
const CONV = uuidv7();
const FUTURE = 4_000_000_000_000;
const NOW = 1_000_000_000_000;

function plan(over: Partial<ActionPlan> = {}): ActionPlan {
  return {
    id: uuidv7(),
    conversationId: CONV,
    actorId: 'alice',
    revisionSha: 'head-1',
    actions: [{ type: 'create-stacked-pr', description: 'fix' }],
    requiredPermissions: ['action:approve'],
    expiresAt: FUTURE,
    status: 'proposed',
    ...over,
  };
}

const opts = { repoAllows: true, actorPermissions: ['action:approve'] };

describe('ActionPlan 持久化', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('conversations')
      .values({
        id: CONV,
        tenant_id: TENANT,
        target_kind: 'change-request',
        target_native_id: '1',
        state: 'active',
        context_revision_sha: 'head-1',
        summary: '',
        active_task_id: null,
        repository_id: null,
        change_request_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  it('insert → load 往返(含 actions/permissions 数组)', async () => {
    const p = plan();
    await insertActionPlan(db, TENANT, p);
    const loaded = await loadActionPlan(db, TENANT, p.id);
    expect(loaded).toMatchObject({
      id: p.id,
      conversationId: CONV,
      actorId: 'alice',
      revisionSha: 'head-1',
      status: 'proposed',
    });
    expect(loaded!.actions).toEqual([{ type: 'create-stacked-pr', description: 'fix' }]);
    expect(loaded!.requiredPermissions).toEqual(['action:approve']);
    expect(loaded!.expiresAt).toBe(FUTURE);
  });

  // The approval must reflect the latest approver.
  it('system-plan approval records the approver, and a later approval replaces it', async () => {
    const p = plan({ actorId: 'winnowl-auto-issue', approvalActor: 'any-authorized' });
    await insertActionPlan(db, TENANT, p);
    const loaded = await loadActionPlan(db, TENANT, p.id);
    expect(loaded).toMatchObject({ approvalActor: 'any-authorized' });
    const confirmed = await confirmActionPlan(
      db,
      TENANT,
      {
        planId: p.id,
        actorId: 'maintainer',
        conversationId: CONV,
        currentHeadSha: 'head-1',
        now: NOW,
      },
      opts,
    );
    expect(confirmed).toMatchObject({ ok: true, plan: { approvedByActorId: 'maintainer' } });
    const reconfirmed = await confirmActionPlan(
      db,
      TENANT,
      { planId: p.id, actorId: 'another-maintainer', conversationId: CONV, currentHeadSha: 'head-1', now: NOW },
      opts,
    );
    expect(reconfirmed).toMatchObject({ ok: true, plan: { approvedByActorId: 'another-maintainer' } });
    expect(await loadActionPlan(db, TENANT, p.id)).toMatchObject({
      approvedByActorId: 'another-maintainer',
    });
  });

  it('确认渠道记进计划(执行期据此选重验方式)', async () => {
    const p = plan({ actorId: 'winnowl-auto-issue', approvalActor: 'any-authorized' });
    await insertActionPlan(db, TENANT, p);
    const approval = {
      source: 'provider-comment' as const,
      actorId: '4711',
      login: 'octocat',
      host: 'https://github.com',
    };
    await confirmActionPlan(
      db,
      TENANT,
      { planId: p.id, actorId: '4711', conversationId: CONV, currentHeadSha: 'head-1', now: NOW },
      { ...opts, approval },
    );
    expect(await loadActionPlan(db, TENANT, p.id)).toMatchObject({
      approvedByActorId: '4711',
      approval,
    });
    // no approval given = console
    const consolePlan = plan({ actorId: 'winnowl-auto-issue', approvalActor: 'any-authorized' });
    await insertActionPlan(db, TENANT, consolePlan);
    await confirmActionPlan(
      db,
      TENANT,
      {
        planId: consolePlan.id,
        actorId: 'console-user',
        conversationId: CONV,
        currentHeadSha: 'head-1',
        now: NOW,
      },
      opts,
    );
    expect(await loadActionPlan(db, TENANT, consolePlan.id)).toMatchObject({
      approval: { source: 'console', actorId: 'console-user' },
    });
  });

  it('persists optional proposal dedupe keys', async () => {
    const p = plan({ dedupeKey: 'auto-issue:repo:fingerprint' });
    await insertActionPlan(db, TENANT, p);
    expect(await loadActionPlan(db, TENANT, p.id)).toMatchObject({ dedupeKey: p.dedupeKey });
  });

  it('确认匹配 → approved', async () => {
    const p = plan();
    await insertActionPlan(db, TENANT, p);
    const r = await confirmActionPlan(
      db,
      TENANT,
      { planId: p.id, actorId: 'alice', conversationId: CONV, currentHeadSha: 'head-1', now: NOW },
      opts,
    );
    expect(r.ok).toBe(true);
    expect((await loadActionPlan(db, TENANT, p.id))!.status).toBe('approved');
  });

  it('Head 变化 / Actor 不符 / 过期 / 无权限 → 拒绝,不改状态', async () => {
    const headChanged = plan();
    await insertActionPlan(db, TENANT, headChanged);
    expect(
      (
        await confirmActionPlan(
          db,
          TENANT,
          {
            planId: headChanged.id,
            actorId: 'alice',
            conversationId: CONV,
            currentHeadSha: 'head-2',
            now: NOW,
          },
          opts,
        )
      ).reason,
    ).toBe('head changed');

    const actorBad = plan();
    await insertActionPlan(db, TENANT, actorBad);
    expect(
      (
        await confirmActionPlan(
          db,
          TENANT,
          {
            planId: actorBad.id,
            actorId: 'bob',
            conversationId: CONV,
            currentHeadSha: 'head-1',
            now: NOW,
          },
          opts,
        )
      ).reason,
    ).toBe('actor mismatch');

    const expired = plan({ expiresAt: NOW - 1 });
    await insertActionPlan(db, TENANT, expired);
    expect(
      (
        await confirmActionPlan(
          db,
          TENANT,
          {
            planId: expired.id,
            actorId: 'alice',
            conversationId: CONV,
            currentHeadSha: 'head-1',
            now: NOW,
          },
          opts,
        )
      ).reason,
    ).toBe('plan expired');

    const noPerm = plan();
    await insertActionPlan(db, TENANT, noPerm);
    expect(
      (
        await confirmActionPlan(
          db,
          TENANT,
          {
            planId: noPerm.id,
            actorId: 'alice',
            conversationId: CONV,
            currentHeadSha: 'head-1',
            now: NOW,
          },
          { repoAllows: true, actorPermissions: [] },
        )
      ).ok,
    ).toBe(false);

    for (const p of [headChanged, actorBad, expired, noPerm]) {
      expect((await loadActionPlan(db, TENANT, p.id))!.status).not.toBe('approved');
    }
  });

  it('未知 plan → not found', async () => {
    expect(
      (
        await confirmActionPlan(
          db,
          TENANT,
          { planId: uuidv7(), actorId: 'alice', conversationId: CONV, now: NOW },
          opts,
        )
      ).reason,
    ).toBe('plan not found');
  });

  it('带 revision 的 plan 在当前 Head 无法由服务端确认时拒绝', async () => {
    const p = plan();
    await insertActionPlan(db, TENANT, p);
    expect(
      (
        await confirmActionPlan(
          db,
          TENANT,
          { planId: p.id, actorId: 'alice', conversationId: CONV, now: NOW },
          opts,
        )
      ).reason,
    ).toBe('current head unavailable');
  });

  it('approval update atomically rejects a plan at its expiry boundary', async () => {
    const p = plan({ expiresAt: NOW });
    await insertActionPlan(db, TENANT, p);
    const result = await confirmActionPlan(
      db,
      TENANT,
      {
        planId: p.id,
        actorId: 'alice',
        conversationId: CONV,
        currentHeadSha: 'head-1',
        now: NOW,
      },
      opts,
    );
    expect(result).toMatchObject({ ok: false, reason: 'plan not pending' });
    expect((await loadActionPlan(db, TENANT, p.id))?.status).toBe('proposed');
  });

  // The TTL gates approval, not execution.
  it('TTL 只拦批准:已批准的过期计划照常可领;没人批准的提议落 expired', async () => {
    const approvedLate = plan({ status: 'approved', expiresAt: NOW - 1 });
    await insertActionPlan(db, TENANT, approvedLate);
    const claimedAfterTtl = await claimActionPlanExecution(db, TENANT, approvedLate.id, NOW);
    expect(claimedAfterTtl?.executionToken).toBeTruthy();
    expect((await loadActionPlan(db, TENANT, approvedLate.id))?.status).toBe('executing');

    // Lease expired and TTL passed: must still be reclaimable.
    const stuckPastTtl = plan({ status: 'approved', expiresAt: FUTURE });
    await insertActionPlan(db, TENANT, stuckPastTtl);
    const stuckFirst = await claimActionPlanExecution(db, TENANT, stuckPastTtl.id, NOW, 30);
    const stuckReclaimed = await claimActionPlanExecution(db, TENANT, stuckPastTtl.id, FUTURE + 1, 30);
    expect(stuckReclaimed?.executionToken).toBeTruthy();
    expect(stuckReclaimed?.executionToken).not.toBe(stuckFirst?.executionToken);

    const staleProposal = plan({ status: 'proposed', expiresAt: NOW - 1 });
    await insertActionPlan(db, TENANT, staleProposal);
    expect(await claimActionPlanExecution(db, TENANT, staleProposal.id, NOW)).toBeNull();
    expect((await loadActionPlan(db, TENANT, staleProposal.id))?.status).toBe('expired');

    // An expired executing lease is reclaimable with a new fencing token.
    const active = plan({ status: 'approved', expiresAt: FUTURE });
    await insertActionPlan(db, TENANT, active);
    const first = await claimActionPlanExecution(db, TENANT, active.id, NOW, 30);
    expect(first?.executionToken).toBeTruthy();
    expect(await claimActionPlanExecution(db, TENANT, active.id, NOW + 10_000, 30)).toBeNull();
    const reclaimed = await claimActionPlanExecution(db, TENANT, active.id, NOW + 31_000, 30);
    expect(reclaimed?.executionToken).toBeTruthy();
    expect(reclaimed?.executionToken).not.toBe(first?.executionToken);
    expect(
      await completeActionPlanExecution(
        db,
        TENANT,
        active.id,
        first!.executionToken!,
        NOW + 32_000,
      ),
    ).toBe(false);
    expect(
      await completeActionPlanExecution(
        db,
        TENANT,
        active.id,
        reclaimed!.executionToken!,
        NOW + 32_000,
      ),
    ).toBe(true);

    const completionExpired = plan({ status: 'approved', expiresAt: FUTURE });
    await insertActionPlan(db, TENANT, completionExpired);
    const claimed = await claimActionPlanExecution(db, TENANT, completionExpired.id, NOW, 30);
    expect(
      await completeActionPlanExecution(
        db,
        TENANT,
        completionExpired.id,
        claimed!.executionToken!,
        NOW + 31_000,
      ),
    ).toBe(false);
  });

  it('list 按 tenant', async () => {
    const list = await listActionPlans(db, TENANT);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((p) => p.conversationId === CONV)).toBe(true);
  });
});
