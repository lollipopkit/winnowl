import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { ReviewExecutorSpec } from '@reviewbot/review-runtime';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { ActionsRunCancelledError, runReviewInActions, type RunInActionsDeps } from '../src/review-in-actions.js';
import { RunnerSetupError } from '../src/executor-error.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const HEAD = 'a'.repeat(40);

const spec = (): ReviewExecutorSpec => ({
  revisionSha: HEAD,
  revisionId: 'rev',
  changedFiles: [],
  headChangedLines: {},
  model: { provider: 'openai', modelId: 'gpt-6-luna', baseUrl: 'https://gw.example/v1', apiKey: 'sk-platform-secret' },
  budget: { maxTurns: 1, maxToolCalls: 1 },
  promptDigests: [],
});

describe('runReviewInActions: park, wait for the action, return or explain', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    const now = new Date();
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: now }).execute();
    await db
      .insertInto('provider_hosts')
      .values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'https://github.com', api_url: 'https://api.github.com', is_saas: true, created_at: now })
      .execute();
    await db
      .insertInto('installations')
      .values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '999', account_login: 'acme', status: 'active', created_at: now })
      .execute();
    await db
      .insertInto('repositories')
      .values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: now })
      .execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  const deps = (jobId: string, extra: Partial<RunInActionsDeps> = {}): RunInActionsDeps => ({
    db,
    tenantId: TENANT,
    jobId,
    repositoryId: REPO,
    changeRequestNumber: 42,
    headSha: HEAD,
    image: 'ghcr.io/lollipopkit/winnowl:sha-test',
    log: () => undefined,
    pollMs: 20,
    ...extra,
  });

  /** Plays the action: waits for the parked run, then moves it along. */
  async function asAction(jobId: string, act: (id: string) => Promise<void>): Promise<void> {
    for (;;) {
      const row = await db.selectFrom('actions_runs').select(['id', 'spec']).where('job_id', '=', jobId).where('status', '=', 'pending').executeTakeFirst();
      if (row) {
        // What reaches the user's runner has no platform key.
        expect(JSON.stringify(row.spec)).not.toContain('sk-platform-secret');
        await db.updateTable('actions_runs').set({ status: 'running', claimed_at: new Date(), heartbeat_at: new Date() }).where('id', '=', row.id).execute();
        return act(row.id);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('returns the posted output, forwards progress, and clears the stored spec and output', async () => {
    const job = uuidv7();
    const progress: string[] = [];
    const action = asAction(job, async (id) => {
      await db.updateTable('actions_runs').set({ progress: { stage: 'verify' }, heartbeat_at: new Date() }).where('id', '=', id).execute();
      await new Promise((r) => setTimeout(r, 80));
      await db.updateTable('actions_runs').set({ status: 'completed', output: { produced: { staged: [] }, pluginCalls: [] } }).where('id', '=', id).execute();
    });
    const out = await runReviewInActions(spec(), deps(job, { onProgress: (p) => progress.push(p.stage) }));
    await action;
    expect(out).toEqual({ produced: { staged: [] }, pluginCalls: [] });
    expect(progress).toContain('verify');
    const row = await db.selectFrom('actions_runs').select(['status', 'spec', 'output']).where('job_id', '=', job).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'closed', spec: null, output: null });
  });

  it('a review no event starts a run for waits for the last run to finish, then re-runs it once', async () => {
    const job = uuidv7();
    const answers: ('wait' | 'started')[] = ['wait', 'wait', 'started'];
    let asked = 0;
    // Every poll is a minute later, so the 20 s spacing never holds a request back.
    let t = 0;
    const action = (async () => {
      while (asked < 3) await new Promise((r) => setTimeout(r, 10));
      // A few more polls: nothing more is requested once the run started.
      await new Promise((r) => setTimeout(r, 100));
      await asAction(job, async (id) => {
        await db.updateTable('actions_runs').set({ status: 'completed', output: { produced: { staged: [] }, pluginCalls: [] } }).where('id', '=', id).execute();
      });
    })();
    await runReviewInActions(
      spec(),
      deps(job, {
        now: () => (t += 60_000),
        claimTimeoutMs: Number.MAX_SAFE_INTEGER,
        requestRun: async () => answers[asked++]!,
      }),
    );
    await action;
    expect(asked).toBe(3);
  });

  it('nobody claims it in time: a final, explained failure', async () => {
    const err = await runReviewInActions(spec(), deps(uuidv7(), { claimTimeoutMs: 100 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerSetupError);
    expect((err as RunnerSetupError).reason).toBe('actions-not-claimed');
    expect((err as RunnerSetupError).retryable).toBe(false);
  });

  it('the executor had no model key: reported as such, not as a generic failure', async () => {
    const job = uuidv7();
    const action = asAction(job, async (id) => {
      await db
        .updateTable('actions_runs')
        .set({ status: 'failed', error: { name: 'LocalCredentialsError', error: 'LLM_API_KEY is not set' } })
        .where('id', '=', id)
        .execute();
    });
    const err = await runReviewInActions(spec(), deps(job)).catch((e: unknown) => e);
    await action;
    expect((err as RunnerSetupError).reason).toBe('actions-no-key');
  });

  it('a claimed run that stops heartbeating is stalled', async () => {
    const job = uuidv7();
    const action = asAction(job, async (id) => {
      await db.updateTable('actions_runs').set({ heartbeat_at: new Date(Date.now() - 60_000) }).where('id', '=', id).execute();
    });
    const err = await runReviewInActions(spec(), deps(job, { stallTimeoutMs: 1_000 })).catch((e: unknown) => e);
    await action;
    expect((err as RunnerSetupError).reason).toBe('actions-stalled');
  });

  it('superseded before anyone claimed it: stops quietly and closes the run', async () => {
    const job = uuidv7();
    const err = await runReviewInActions(spec(), deps(job, { isCancelled: () => true })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionsRunCancelledError);
    const row = await db.selectFrom('actions_runs').select('status').where('job_id', '=', job).executeTakeFirstOrThrow();
    expect(row.status).toBe('closed');
  });
});
