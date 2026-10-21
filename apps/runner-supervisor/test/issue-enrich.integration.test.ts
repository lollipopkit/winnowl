import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createIssueEnrichHandler } from '../src/issue-enrich.js';
import { Supervisor } from '../src/supervisor.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const noopSandbox = { create: async () => ({ id: 's', containerId: 'c' }), exec: async () => { throw new Error('x'); }, putFile: async () => undefined, getArtifact: async () => ({ path: '', content: '', bytes: 0 }), destroy: async () => undefined } as unknown as SandboxBackend;

interface Comment { number: number; markdown: string; key: string }

function provider(comments: Comment[]): SourceControlProvider {
  return {
    issues: {
      get: async (_repo: unknown, number: number) => ({ nativeId: '900', number, title: 'App crashes on start', body: 'Steps: run app', state: 'open', labels: [] }),
      comment: async (ref: { number: number }, body: { markdown: string }, idem: { key: string }) => {
        comments.push({ number: ref.number, markdown: body.markdown, key: idem.key });
        return { nativeId: 'c1' };
      },
    },
  } as unknown as SourceControlProvider;
}

const repoRef = { id: REPO, providerHostId: HOST, installationId: INSTALL, nativeId: '900', namespace: 'acme', name: 'app', cloneUrl: 'x', defaultBranch: 'main' };

describe('issue_enrich handler', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let workerId: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  });

  afterAll(async () => {
    await stop?.();
  });

  function supervisor(comments: Comment[], tool: string, args: Record<string, unknown>): Supervisor {
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall(tool, args))]);
    const handler = createIssueEnrichHandler({
      // language zh: triage/plan bodies are localized.
      buildEnv: async () => ({ provider: provider(comments), repo: repoRef, model: faux.model, streamFn: faux.streamFn, language: 'zh' }),
    });
    return new Supervisor({ db, sandbox: noopSandbox, workerId, handlers: { issue_enrich: handler } });
  }

  it('mode enrich → 发布分诊评论(建议标签不自动应用)', async () => {
    const comments: Comment[] = [];
    await enqueueJob(db, { tenantId: TENANT, type: 'issue_enrich', payload: { tenantId: TENANT, repositoryId: REPO, issueNativeId: '900', issueNumber: 7, mode: 'enrich' }, dedupeKey: 'ie-1' });
    await supervisor(comments, 'submit_enrichment', {
      duplicateOf: [], relatedIssues: ['#3'], relatedChangeRequests: [], relatedCode: [{ file: 'src/main.ts' }],
      suggestedLabels: ['bug'], suggestedOwners: [], reproductionQuestions: ['OS version?'], feasibility: 'needs-clarification', riskClassification: 'medium',
    }).runOnce();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.markdown).toContain('Issue 分诊');
    expect(comments[0]!.markdown).toContain('未自动应用');
    expect(comments[0]!.key).toBe(`issue-enrich:${REPO}:7`);
  });

  it('mode plan → 发布 implementation plan', async () => {
    const comments: Comment[] = [];
    await enqueueJob(db, { tenantId: TENANT, type: 'issue_enrich', payload: { tenantId: TENANT, repositoryId: REPO, issueNativeId: '900', issueNumber: 7, mode: 'plan' }, dedupeKey: 'ie-2' });
    await supervisor(comments, 'submit_plan', {
      understanding: 'Init fails when config missing', assumptions: ['config path default'], relatedCode: [{ file: 'src/main.ts' }],
      likelyRootCause: 'missing null check', changeSteps: ['add guard'], testSteps: ['unit test'], risks: [], openQuestions: [], canStartCodingAgent: true,
    }).runOnce();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.markdown).toContain('实现计划'); // language zh localizes section titles
    expect(comments[0]!.key).toBe(`issue-plan:${REPO}:7`);
  });
});
