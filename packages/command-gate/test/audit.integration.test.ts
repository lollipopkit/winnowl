import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { previousCommands, purgeCommandAudit, recordCommandDecision, recordCommandResult } from '../src/index.js';

const TENANT = uuidv7();
const JOB = uuidv7();

describe('agent_commands audit', () => {
  let db: Db;
  let stop: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
  });
  afterAll(async () => {
    await stop?.();
  });

  it('records decisions and results, gives the job history oldest first, and expires old rows', async () => {
    const scope = { tenantId: TENANT, jobId: JOB };
    const a = await recordCommandDecision(db, scope, { command: 'npm ci', purpose: 'deps' }, { verdict: 'allow', decidedBy: 'rule', rule: 'toolchain', reason: 'routine command' });
    await recordCommandResult(db, a, { exitCode: 0, timedOut: false, durationMs: 12_345.6 });
    await recordCommandDecision(db, scope, { command: 'npm publish' }, { verdict: 'deny', decidedBy: 'rule', rule: 'publish:npm', reason: 'no' });
    await recordCommandDecision(db, scope, { command: 'curl https://x' }, { verdict: 'allow', decidedBy: 'judge', rule: 'download', reason: 'docs', judgeCostUsd: 0.000123 });

    expect(await previousCommands(db, JOB)).toEqual([
      { command: 'npm ci', verdict: 'allow' },
      { command: 'npm publish', verdict: 'deny' },
      { command: 'curl https://x', verdict: 'allow' },
    ]);
    const row = await db.selectFrom('agent_commands').selectAll().where('id', '=', a).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ exit_code: 0, timed_out: false, oom_killed: false, duration_ms: 12_346, purpose: 'deps' });
    expect(row.finished_at).not.toBeNull();

    await db.updateTable('agent_commands').set({ created_at: new Date(Date.now() - 31 * 86_400_000) }).where('id', '=', a).execute();
    expect(await purgeCommandAudit(db, TENANT, 30)).toBe(1);
    expect(await previousCommands(db, JOB)).toHaveLength(2);
  });
});
