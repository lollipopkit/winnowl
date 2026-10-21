import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createGlobalLearningProposeHandler } from '../src/global-learning-propose.js';
import type { JobHandler } from '../src/supervisor.js';

/** Calls the handler directly; global_learnings has no FK, so empty triage findings are fine. */
function run(handler: JobHandler, db: Db, payload: unknown): Promise<unknown> {
  return handler({ job: { payload } as never, db, log: () => undefined } as unknown as Parameters<JobHandler>[0]);
}

function vote(decision: 'approve' | 'reject', confidence: number) {
  const f = createFauxAgent();
  f.setResponses([f.assistant(f.toolCall('submit_vote', { decision, confidence, reasoning: `${decision} ${confidence}` }))]);
  return f;
}

describe('global_learning_propose handler(§多模型自动提议)', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
  });
  afterAll(async () => {
    await stop?.();
  });

  const payload = { tenantId: uuidv7(), repositoryId: uuidv7(), revisionId: uuidv7() };

  it('triage yes → draft → 三模型投票 → 存 proposed(origin=auto)+ deliberation', async () => {
    const draft = createFauxAgent();
    draft.setResponses([
      draft.assistant(draft.toolCall('submit_triage', { worthGlobal: true, signalKind: 'design', note: 'nice pattern' })),
      draft.assistant(draft.toolCall('submit_finding', { instruction: '全局规则 G', rationale: 'because', locality: 'none', evidence: ['recurs across tenants'] })),
    ]);
    const handler = createGlobalLearningProposeHandler({
      resolveModels: async () => ({
        draftModel: draft,
        panelModels: [
          { id: 'model-a', source: vote('approve', 0.9) },
          { id: 'model-b', source: vote('approve', 0.8) },
          { id: 'model-c', source: vote('reject', 0.5) },
        ],
      }),
    });
    await run(handler, db, payload);

    const row = await db.selectFrom('global_learnings').selectAll().where('instruction', '=', '全局规则 G').executeTakeFirst();
    expect(row).toBeTruthy();
    expect(row!.origin).toBe('auto');
    expect(row!.status).toBe('proposed');
    expect(row!.proposed_by).toBe('system');
    // Aggregate confidence: 2/3 pass × (0.9+0.8)/2 = 0.567.
    expect(Number(row!.confidence)).toBeCloseTo(0.567, 2);
    const delib = row!.deliberation as unknown as { panel: unknown[]; aggregate: { approvals: number; total: number } };
    expect(delib.panel).toHaveLength(3);
    expect(delib.aggregate).toMatchObject({ approvals: 2, total: 3 });
  });

  it('triage no → 不产提议', async () => {
    const draft = createFauxAgent();
    draft.setResponses([draft.assistant(draft.toolCall('submit_triage', { worthGlobal: false, signalKind: 'none', note: 'nothing generalizable' }))]);
    const handler = createGlobalLearningProposeHandler({
      resolveModels: async () => ({ draftModel: draft, panelModels: [{ id: 'model-a', source: vote('approve', 0.9) }] }),
    });
    const before = await db.selectFrom('global_learnings').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
    await run(handler, db, { tenantId: uuidv7(), repositoryId: uuidv7(), revisionId: uuidv7() });
    const after = await db.selectFrom('global_learnings').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
    expect(Number(after!.n)).toBe(Number(before!.n)); // nothing added
  });
});
