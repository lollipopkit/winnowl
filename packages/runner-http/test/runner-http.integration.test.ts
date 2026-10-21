import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { ensureRunnerPool, enqueueJob } from '@reviewbot/queue';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTokenAuthority,
  handleClaim,
  handleComplete,
  handleHeartbeat,
  handleRenew,
  handleRegister,
  handleStart,
} from '../src/index.js';

const TENANT = uuidv7();
const SECRET = 'server-hmac-secret';
const REG = 'one-time-registration-token';

describe('Runner HTTP 传输', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let poolId: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
  });

  afterAll(async () => {
    await stop?.();
  });

  const tokens = (): ReturnType<typeof createTokenAuthority> =>
    createTokenAuthority({
      secret: SECRET,
      registration: {
        token: REG,
        poolId,
        capabilities: { os: 'linux' },
        maxConcurrency: 2,
      },
    });
  const deps = () => ({ db, tokens: tokens() });

  it('register:错误 Registration Token → 401;正确 → workerId + Runner Token', async () => {
    const bad = await handleRegister(deps(), {
      version: '1',
      registrationToken: 'wrong',
    });
    expect(bad.status).toBe(401);
    const ok = await handleRegister(deps(), {
      version: '1',
      registrationToken: REG,
    });
    expect(ok.status).toBe(200);
    const body = ok.body as { workerId: string; runnerToken: string };
    expect(body.workerId).toBeTruthy();
    expect(tokens().verifyRunnerToken(body.runnerToken)?.workerId).toBe(body.workerId);
    expect(
      await db
        .selectFrom('workers')
        .select(['pool_id', 'capabilities', 'max_concurrency'])
        .where('id', '=', body.workerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ pool_id: poolId, capabilities: { os: 'linux' }, max_concurrency: 2 });
  });

  it('claim → 领 job + Job Token;错误 Runner Token → 401;Job Token 完成', async () => {
    const reg = (
      await handleRegister(deps(), {
        version: '1',
        registrationToken: REG,
      })
    ).body as { workerId: string; runnerToken: string };
    const traceCarrier = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };
    await enqueueJob(db, {
      tenantId: TENANT,
      type: 'review_revision',
      payload: { x: 1 },
      dedupeKey: 'rh-1',
      traceCarrier,
    });

    const bad = await handleClaim(deps(), tokens().issueRunnerToken('other-worker'), {
      workerId: reg.workerId,
      leaseSeconds: 60,
    });
    expect(bad.status).toBe(401);

    const claim = await handleClaim(deps(), reg.runnerToken, {
      workerId: reg.workerId,
      leaseSeconds: 60,
    });
    const job = (
      claim.body as {
        job: {
          id: string;
          type: string;
          jobToken: string;
          traceCarrier?: Record<string, string>;
        } | null;
      }
    ).job!;
    expect(job.type).toBe('review_revision');
    expect(job.traceCarrier).toEqual(traceCarrier);
    const jobClaims = tokens().verifyJobToken(job.jobToken);
    expect(jobClaims).toEqual({ jobId: job.id, workerId: reg.workerId });

    // start + renew + complete use the job token; renew rotates it.
    expect((await handleStart(deps(), job.jobToken, job.id)).status).toBe(204);
    const renewed = await handleRenew(deps(), job.jobToken, job.id, {
      jobId: job.id,
      workerId: reg.workerId,
      leaseSeconds: 60,
    });
    expect(renewed.status).toBe(200);
    const renewedToken = (renewed.body as { jobToken: string }).jobToken;
    const done = await handleComplete(deps(), renewedToken, job.id, {
      jobId: job.id,
      workerId: reg.workerId,
      outcome: 'completed',
    });
    expect(done.status).toBe(204);
    const row = await db
      .selectFrom('jobs')
      .select('status')
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('completed');
  });

  // Unknown classes become `internal_bug`; the worker's own `retryable` must be passed through.
  it('complete(failed):认不出的分类按 internal_bug;retryable 透传', async () => {
    const reg = (
      await handleRegister(deps(), { version: '1', registrationToken: REG })
    ).body as { workerId: string; runnerToken: string };
    const claimOne = async (key: string): Promise<{ id: string; jobToken: string }> => {
      await enqueueJob(db, { tenantId: TENANT, type: 'review_revision', payload: {}, dedupeKey: key });
      const body = (
        await handleClaim(deps(), reg.runnerToken, { workerId: reg.workerId, leaseSeconds: 60 })
      ).body as { job: { id: string; jobToken: string } };
      return body.job;
    };
    const failureOf = async (id: string): Promise<Record<string, unknown>> =>
      (
        await db
          .selectFrom('jobs')
          .select(['status', 'attempt_count', 'last_error'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ) as unknown as Record<string, unknown>;

    const bogus = await claimOne('rh-fail-bogus');
    await handleStart(deps(), bogus.jobToken, bogus.id, { workerId: reg.workerId });
    expect(
      (
        await handleComplete(deps(), bogus.jobToken, bogus.id, {
          jobId: bogus.id,
          workerId: reg.workerId,
          outcome: 'failed',
          failureClass: 'not-a-real-class',
          message: 'boom',
        })
      ).status,
    ).toBe(200);
    const bogusRow = await failureOf(bogus.id);
    expect((bogusRow.last_error as { class?: string }).class).toBe('internal_bug');
    expect(bogusRow.status).toBe('failed'); // internal_bug is not retryable

    const retried = await claimOne('rh-fail-retryable');
    await handleStart(deps(), retried.jobToken, retried.id, { workerId: reg.workerId });
    await handleComplete(deps(), retried.jobToken, retried.id, {
      jobId: retried.id,
      workerId: reg.workerId,
      outcome: 'failed',
      failureClass: 'internal_bug', // the class says not retryable,
      retryable: true, // but the worker says this attempt is
      message: 'transient',
    });
    expect((await failureOf(retried.id)).status).toBe('queued');
  });

  it('complete 用他 job 的 Token → 401(Job Token 仅当前 Job)', async () => {
    const res = await handleComplete(
      deps(),
      tokens().issueJobToken('other-job', 'w', 60),
      'this-job',
      { jobId: 'this-job', workerId: 'w', outcome: 'completed' },
    );
    expect(res.status).toBe(401);
  });

  it('过期 Runner Token → 拒绝', async () => {
    const past = createTokenAuthority({
      secret: SECRET,
      registration: { token: REG, poolId, capabilities: {}, maxConcurrency: 1 },
      now: () => 1_000_000,
    });
    const token = past.issueRunnerToken('w', 1);
    const future = createTokenAuthority({
      secret: SECRET,
      registration: { token: REG, poolId, capabilities: {}, maxConcurrency: 1 },
      now: () => 10_000_000,
    });
    expect(future.verifyRunnerToken(token)).toBeNull();
  });

  it('heartbeat:draining 模式落库', async () => {
    const reg = (
      await handleRegister(deps(), {
        version: '1',
        registrationToken: REG,
      })
    ).body as { workerId: string; runnerToken: string };
    const res = await handleHeartbeat(deps(), reg.runnerToken, {
      workerId: reg.workerId,
      runningJobs: 0,
      mode: 'draining',
    });
    expect(res.status).toBe(204);
    const row = await db
      .selectFrom('workers')
      .select('mode')
      .where('id', '=', reg.workerId)
      .executeTakeFirstOrThrow();
    expect(row.mode).toBe('draining');
  });

  it('claim rejects unsafe lease durations', async () => {
    const reg = (await handleRegister(deps(), { version: '1', registrationToken: REG })).body as {
      workerId: string;
      runnerToken: string;
    };
    for (const leaseSeconds of [-1, 0, 29, 301, Number.POSITIVE_INFINITY]) {
      const result = await handleClaim(deps(), reg.runnerToken, {
        workerId: reg.workerId,
        leaseSeconds,
      });
      expect(result).toEqual({ status: 400, body: { error: 'lease_seconds_out_of_range' } });
    }
  });
});
