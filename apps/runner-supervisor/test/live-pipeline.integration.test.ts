import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveModelSourceFromEnv } from '@reviewbot/agent-pi';
import { createDb, type Db } from '@reviewbot/db';
import type { ChangeRequestRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import { GithubProvider } from '@reviewbot/provider-github';
import { RestClient } from '@reviewbot/provider-http';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createPipelineAnalyzeHandler } from '../src/pipeline-analyze.js';
import { Supervisor } from '../src/supervisor.js';

const token = process.env.REVIEWBOT_LIVE_GITHUB_TOKEN;
const repoSlug = process.env.REVIEWBOT_LIVE_GITHUB_REPO;
const prNumber = process.env.REVIEWBOT_LIVE_GITHUB_PR;
const baseUrl = process.env.REVIEWBOT_LIVE_GITHUB_API ?? 'https://api.github.com';
const [owner, name] = (repoSlug ?? '/').split('/');
const enabled = Boolean(
  token && repoSlug && prNumber && process.env.LLM_LIVE && process.env.LLM_MODEL,
);

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();
const noopSandbox = {
  create: async () => ({ id: 's', containerId: 'c' }),
  exec: async () => {
    throw new Error('x');
  },
  putFile: async () => undefined,
  getArtifact: async () => ({ path: '', content: '', bytes: 0 }),
  destroy: async () => undefined,
} as unknown as SandboxBackend;

function provider(): GithubProvider {
  return new GithubProvider({
    client: new RestClient({ baseUrl, authorization: () => `token ${token}` }),
    host: { id: 'live', provider: 'github', baseUrl, apiUrl: baseUrl, isSaas: true },
    resolveRepo: () => ({ owner: owner ?? '', repo: name ?? '' }),
  });
}

describe.skipIf(!enabled)('M8 pipeline_analyze live:真实 CI 失败 → 根因评论(§29)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let workerId: string;
  let headSha: string;

  beforeAll(async () => {
    const p = provider();
    const crRef: ChangeRequestRef = {
      id: CR,
      repositoryId: REPO,
      nativeId: 'live',
      number: Number(prNumber),
      kind: 'pull-request',
    };
    headSha = (await p.changes.getRevision(crRef)).headSha;

    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('provider_hosts')
      .values({
        id: HOST,
        tenant_id: TENANT,
        provider: 'github',
        base_url: 'x',
        api_url: baseUrl,
        is_saas: true,
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('installations')
      .values({
        id: INSTALL,
        tenant_id: TENANT,
        provider_host_id: HOST,
        native_id: '1',
        account_login: owner ?? 'x',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('repositories')
      .values({
        id: REPO,
        tenant_id: TENANT,
        provider_host_id: HOST,
        installation_id: INSTALL,
        native_id: 'live',
        namespace: owner ?? '',
        name: name ?? '',
        clone_url: `https://github.com/${repoSlug}.git`,
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('change_requests')
      .values({
        id: CR,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: 'live',
        number: Number(prNumber),
        kind: 'pull-request',
        source_branch: 'feature/mul',
        target_branch: 'main',
        state: 'open',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  }, 60_000);

  afterAll(async () => {
    await stop?.();
  });

  it('拉真实失败 run 日志 → 脱敏/归一化/关联变更 → 根因 agent → 发布评论', async () => {
    const source = resolveModelSourceFromEnv();
    if (!source) throw new Error('no model source');
    const p = provider();
    const crRef: ChangeRequestRef = {
      id: CR,
      repositoryId: REPO,
      nativeId: 'live',
      number: Number(prNumber),
      kind: 'pull-request',
    };
    const changedFiles = await p.changes.listChangedFiles({
      id: CR,
      repositoryId: REPO,
      nativeId: 'live',
      number: Number(prNumber),
      kind: 'pull-request',
    });
    const changedPaths = new Set(
      changedFiles.map((f) => f.newPath ?? f.oldPath ?? '').filter(Boolean),
    );
    const failureConclusions = new Set([
      'failure',
      'timed_out',
      'startup_failure',
      'action_required',
    ]);
    const failedRuns = (await p.pipelines.listRuns(crRef)).filter(
      (run) => run.conclusion && failureConclusions.has(run.conclusion),
    );
    let failedJobs = 0;
    for (const run of failedRuns) {
      failedJobs += (await p.pipelines.getJobs(run.ref)).filter(
        (job) => job.conclusion && failureConclusions.has(job.conclusion),
      ).length;
    }
    expect(
      failedJobs,
      'live pipeline fixture must contain at least one failed CI job',
    ).toBeGreaterThan(0);

    const handler = createPipelineAnalyzeHandler({
      buildEnv: async () => ({
        provider: p,
        changed: { isChangedFile: (path: string) => changedPaths.has(path) },
        model: source.model,
        streamFn: source.streamFn,
      }),
    });
    const { jobId } = await enqueueJob(db, {
      tenantId: TENANT,
      type: 'pipeline_analyze',
      payload: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequestId: CR,
        revisionId: REV,
        headSha,
      },
      dedupeKey: `pa-${Date.now()}`,
    });
    await new Supervisor({
      db,
      sandbox: noopSandbox,
      workerId,
      handlers: { pipeline_analyze: handler },
    }).runOnce();

    const jobStatus = (
      await db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow()
    ).status;
    expect(jobStatus).toBe('completed');
    const publication = await db
      .selectFrom('publication_records')
      .select(['state', 'provider_native_id'])
      .where('change_request_id', '=', CR)
      .where('kind', '=', 'ci-analysis')
      .executeTakeFirst();
    expect(publication).toMatchObject({ state: 'published' });
    expect(publication?.provider_native_id).toBeTruthy();
    console.log(
      '[live-pipeline] pipeline_analyze completed for',
      repoSlug,
      'PR',
      prNumber,
      'changedPaths=',
      [...changedPaths],
    );
  }, 180_000);
});
