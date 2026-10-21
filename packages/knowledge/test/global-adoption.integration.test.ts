import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  insertGlobalLearning,
  listPendingGlobalLearnings,
  loadApplicableKnowledge,
  newGlobalLearning,
  transitionGlobalLearning,
  upsertGlobalLearningAdoption,
} from '../src/index.js';

const TENANT = uuidv7();
const TENANT_B = uuidv7();
const REPO = uuidv7();
const REPO2 = uuidv7();
const operator = { isPlatformOperator: true, ref: 'op' };

async function approveNewGlobal(db: Db, instruction: string, enforcement: 'default' | 'mandatory' = 'default'): Promise<string> {
  const g = newGlobalLearning({ instruction, rationale: 'r', enforcement, proposedBy: 'op' });
  await insertGlobalLearning(db, g);
  const r = await transitionGlobalLearning(db, g.id, { action: 'approve', actor: operator });
  expect(r.ok).toBe(true);
  return g.id;
}

async function injected(db: Db, tenantId: string, repositoryId: string): Promise<string[]> {
  const items = await loadApplicableKnowledge(db, { tenantId, repositoryId });
  return items.map((i) => i.content);
}

describe('Global Learning 租户采纳', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    for (const t of [TENANT, TENANT_B]) {
      await db.insertInto('tenants').values({ id: t, name: t.slice(0, 6), region: null, created_at: new Date() }).execute();
    }
  });
  afterAll(async () => {
    await stop?.();
  });

  it('prompt(默认)+ 无 adoption 行 → default global 不注入;mandatory 恒注入', async () => {
    await approveNewGlobal(db, 'G-default');
    await approveNewGlobal(db, 'G-mandatory', 'mandatory');
    const items = await injected(db, TENANT, REPO);
    expect(items).not.toContain('G-default');
    expect(items).toContain('G-mandatory');
  });

  it('pending 收件箱:default 无行列出;mandatory/已决不列;白名单字段无 source/deliberation', async () => {
    const pending = await listPendingGlobalLearnings(db, TENANT);
    expect(pending.map((p) => p.instruction)).toEqual(['G-default']);
    expect(Object.keys(pending[0]!).sort()).toEqual(['enforcement', 'id', 'instruction', 'locality', 'rationale']);
  });

  it('adopt org → 注入全仓;重复决定 upsert 覆盖为 declined → 不注入且不再 pending', async () => {
    const pending = await listPendingGlobalLearnings(db, TENANT);
    const id = pending[0]!.id;
    await upsertGlobalLearningAdoption(db, TENANT, { globalLearningId: id, status: 'accepted', decidedBy: 'owner-a' });
    expect(await injected(db, TENANT, REPO)).toContain('G-default');
    expect(await injected(db, TENANT, REPO2)).toContain('G-default');
    // Overwrite with declined.
    await upsertGlobalLearningAdoption(db, TENANT, { globalLearningId: id, status: 'declined', decidedBy: 'owner-a' });
    expect(await injected(db, TENANT, REPO)).not.toContain('G-default');
    expect((await listPendingGlobalLearnings(db, TENANT)).map((p) => p.id)).not.toContain(id);
  });

  it('adopt repo scope:命中 repository_ids 才注入', async () => {
    const id = (await listPendingGlobalLearnings(db, TENANT_B))[0]!.id;
    await upsertGlobalLearningAdoption(db, TENANT_B, { globalLearningId: id, status: 'accepted', scope: 'repo', repositoryIds: [REPO], decidedBy: 'admin-b' });
    expect(await injected(db, TENANT_B, REPO)).toContain('G-default');
    expect(await injected(db, TENANT_B, REPO2)).not.toContain('G-default');
  });

  it('租户隔离:A 的采纳不影响 B;policy=auto_accept 无行视同采纳;ignore 仅 mandatory 且收件箱空', async () => {
    const gid = await approveNewGlobal(db, 'G-second');
    // Undecided in both repos (the repo-scope row only covers G-default).
    expect(await injected(db, TENANT, REPO)).not.toContain('G-second');

    await db.updateTable('tenants').set({ global_learnings_policy: 'auto_accept' }).where('id', '=', TENANT).execute();
    expect(await injected(db, TENANT, REPO)).toContain('G-second'); // no row counts as adopted
    // Declined is never injected, even under auto_accept.
    expect(await injected(db, TENANT, REPO)).not.toContain('G-default');

    await db.updateTable('tenants').set({ global_learnings_policy: 'ignore' }).where('id', '=', TENANT).execute();
    const items = await injected(db, TENANT, REPO);
    expect(items).not.toContain('G-second');
    expect(items).toContain('G-mandatory'); // mandatory is exempt
    expect(await listPendingGlobalLearnings(db, TENANT)).toEqual([]); // ignore shows no inbox
    void gid;
  });

  it('expired global learnings are neither injected (even mandatory) nor offered for adoption (0003)', async () => {
    const past = Date.now() - 60_000;
    for (const [instruction, enforcement] of [['G-expired-mandatory', 'mandatory'], ['G-expired-default', 'default']] as const) {
      const g = newGlobalLearning({ instruction, rationale: 'r', enforcement, proposedBy: 'op', expiresAt: past });
      await insertGlobalLearning(db, g);
      expect((await transitionGlobalLearning(db, g.id, { action: 'approve', actor: operator })).ok).toBe(true);
    }
    const items = await injected(db, TENANT_B, REPO);
    expect(items).not.toContain('G-expired-mandatory');
    const pending = await listPendingGlobalLearnings(db, TENANT_B);
    expect(pending.map((p) => p.instruction)).not.toContain('G-expired-default');
  });
});
