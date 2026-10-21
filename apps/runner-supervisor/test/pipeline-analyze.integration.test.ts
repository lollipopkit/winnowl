import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createPipelineAnalyzeHandler } from '../src/pipeline-analyze.js';
import { Supervisor } from '../src/supervisor.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const CR3 = uuidv7();
const noopSandbox = { create: async () => ({ id: 's', containerId: 'c' }), exec: async () => { throw new Error('x'); }, putFile: async () => undefined, getArtifact: async () => ({ path: '', content: '', bytes: 0 }), destroy: async () => undefined } as unknown as SandboxBackend;

interface Posted { markdown: string; key: string }

function provider(posted: Posted[], logText: string, conclusion: string): SourceControlProvider {
  return {
    pipelines: {
      listRuns: async () => [{ ref: { nativeId: 'run1', repositoryId: REPO }, status: 'completed', headSha: 'head-1', conclusion }],
      getJobs: async () => [{ ref: { nativeId: 'job1', repositoryId: REPO }, name: 'build', status: 'completed', conclusion }],
      getLogs: async () => ({ text: logText, truncated: false }),
    },
    changes: { listChangedFiles: async () => [{ newPath: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 }] },
    discussions: {
      createTopLevelComment: async (_t: unknown, body: { markdown: string }, idem: { key: string }) => {
        posted.push({ markdown: body.markdown, key: idem.key });
        return { nativeId: 'c1' };
      },
    },
  } as unknown as SourceControlProvider;
}

describe('pipeline_analyze handler', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let workerId: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    await db.insertInto('change_requests').values({ id: CR, tenant_id: TENANT, repository_id: REPO, native_id: '42', number: 42, kind: 'pull-request', source_branch: 'feat', target_branch: 'main', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() }).execute();
    await db.insertInto('change_requests').values({ id: CR3, tenant_id: TENANT, repository_id: REPO, native_id: '43', number: 43, kind: 'pull-request', source_branch: 'feat3', target_branch: 'main', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() }).execute();
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  });

  afterAll(async () => {
    await stop?.();
  });

  function supervisor(posted: Posted[], logText: string, conclusion: string): Supervisor {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(
        faux.toolCall('submit_root_cause', {
          summary: 'Type error introduced by the new signature.',
          causingChange: 'src/app.ts signature change',
          sameRootCauseGroups: [['job1']],
          verifiableFix: 'Align the caller types.',
          codeLocations: [{ file: 'src/app.ts', line: 12 }],
          confidence: 0.8,
        }),
      ),
    ]);
    const handler = createPipelineAnalyzeHandler({
      buildEnv: async () => ({
        provider: provider(posted, logText, conclusion),
        changed: { isChangedFile: (p: string) => p === 'src/app.ts' },
        model: faux.model,
        streamFn: faux.streamFn,
      }),
    });
    return new Supervisor({ db, sandbox: noopSandbox, workerId, handlers: { pipeline_analyze: handler } });
  }

  it('CI 失败 + 命中变更诊断 → 发布根因评论(幂等键含 Head)', async () => {
    const posted: Posted[] = [];
    await enqueueJob(db, { tenantId: TENANT, type: 'pipeline_analyze', payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: CR, revisionId: uuidv7(), headSha: 'head-1' }, dedupeKey: 'pa-1' });
    await supervisor(posted, 'src/app.ts(12,5): error TS2345: bad types\n', 'failure').runOnce();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.markdown).toContain('CI failure root-cause analysis');
    expect(posted[0]!.markdown).toContain('src/app.ts');
    expect(posted[0]!.key).toBe(`ci-analysis:${CR}`); // the idempotency key has no headSha: one comment per PR
  });

  it('无失败 Job(结论 success)→ 不评论', async () => {
    const posted: Posted[] = [];
    await enqueueJob(db, { tenantId: TENANT, type: 'pipeline_analyze', payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: CR, revisionId: uuidv7(), headSha: 'head-2' }, dedupeKey: 'pa-2' });
    await supervisor(posted, 'all good\n', 'success').runOnce();
    expect(posted).toHaveLength(0);
  });

  it('GitHub Actions 时间戳前缀日志 → strip 后仍归一化诊断并评论', async () => {
    const posted: Posted[] = [];
    await enqueueJob(db, { tenantId: TENANT, type: 'pipeline_analyze', payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: CR3, revisionId: uuidv7(), headSha: 'head-3' }, dedupeKey: 'pa-3' });
    // Lines carry ISO8601 timestamp prefixes (real GitHub Actions job logs); unstripped, the ^file anchor fails.
    await supervisor(posted, '2026-07-16T06:00:00.1234567Z src/app.ts(12,5): error TS2345: bad types\n', 'failure').runOnce();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.markdown).toContain('src/app.ts');
  });

  it('ADR-013:同 PR 重跑、根因不变 → 不重复发帖(用户报的堆叠 bug)', async () => {
    const CR2 = uuidv7();
    await db.insertInto('change_requests').values({ id: CR2, tenant_id: TENANT, repository_id: REPO, native_id: '44', number: 44, kind: 'pull-request', source_branch: 'feat2', target_branch: 'main', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() }).execute();
    const posted: Posted[] = [];
    // First CI failure: one comment.
    await enqueueJob(db, { tenantId: TENANT, type: 'pipeline_analyze', payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: CR2, revisionId: uuidv7(), headSha: 'h1' }, dedupeKey: 'adr-1' });
    await supervisor(posted, 'src/x.ts(3,1): error TS2345: bad\n', 'failure').runOnce();
    // New head, same root cause: no second comment.
    await enqueueJob(db, { tenantId: TENANT, type: 'pipeline_analyze', payload: { tenantId: TENANT, repositoryId: REPO, changeRequestId: CR2, revisionId: uuidv7(), headSha: 'h2' }, dedupeKey: 'adr-2' });
    await supervisor(posted, 'src/x.ts(3,1): error TS2345: bad\n', 'failure').runOnce();
    expect(posted).toHaveLength(1); // root-cause fingerprint unchanged → skipped
    // publication_records has one row too.
    const recs = await db.selectFrom('publication_records').selectAll().where('change_request_id', '=', CR2).where('kind', '=', 'ci-analysis').execute();
    expect(recs).toHaveLength(1);
  });
});
