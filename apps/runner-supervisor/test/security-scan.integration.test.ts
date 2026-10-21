import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend, SourceProvider } from '@reviewbot/agent-pi';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createSecurityScanHandler } from '../src/security-scan.js';
import { Supervisor } from '../src/supervisor.js';

const TENANT = uuidv7();
const REPO = uuidv7();

const noopSandbox = { create: async () => ({ id: 's', containerId: 'c' }), exec: async () => { throw new Error('x'); }, putFile: async () => undefined, getArtifact: async () => ({ path: '', content: '', bytes: 0 }), destroy: async () => undefined } as unknown as SandboxBackend;

const emptySource: SourceProvider = {
  listChangedFiles: async () => [],
  readFile: async () => null,
  searchCode: async () => [],
};

describe('security_scan handler', () => {
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

  function supervisor(findings: Record<string, unknown>[]): Supervisor {
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('submit_security_findings', { findings }))]);
    const handler = createSecurityScanHandler({
      newId: () => uuidv7(),
      buildScanEnv: async () => ({ source: emptySource, model: faux.model, streamFn: faux.streamFn, repoContext: 'repo acme/app' }),
    });
    return new Supervisor({ db, sandbox: noopSandbox, workerId, handlers: { security_scan: handler } });
  }

  it('Finding → 私密审计(含 exploit 细节 + 高危 elevated)+ 汇总', async () => {
    await enqueueJob(db, { tenantId: TENANT, type: 'security_scan', payload: { tenantId: TENANT, repositoryId: REPO, trigger: 'manual' }, dedupeKey: 'sec-1' });
    await supervisor([
      { title: 'SQL injection in query builder', severity: 'high', category: 'sast', publicSummary: 'user input concatenated', exploitDetails: "'; DROP TABLE users; --", locationPermalink: 'src/db.ts#L10' },
      { title: 'Hardcoded API key', severity: 'critical', category: 'secret', publicSummary: 'key in source', exploitDetails: 'key=sk-live-xxx', locationPermalink: 'src/cfg.ts#L3' },
    ]).runOnce();

    const findings = await db.selectFrom('audit_events').selectAll().where('action', '=', 'security.finding').where('target', '=', REPO).execute();
    expect(findings).toHaveLength(2);
    const high = findings.find((f) => (f.detail as { severity: string }).severity === 'high')!;
    expect((high.detail as { elevated: boolean }).elevated).toBe(true);
    // Private channel: exploit details are fully disclosed.
    expect((high.detail as { body: string }).body).toContain('DROP TABLE');

    const summary = await db.selectFrom('audit_events').selectAll().where('action', '=', 'security.scan').where('target', '=', REPO).executeTakeFirst();
    expect((summary!.detail as { count: number }).count).toBe(2);
    expect((summary!.detail as { bySeverity: Record<string, number> }).bySeverity).toMatchObject({ high: 1, critical: 1 });
  });

  it('无 Finding → 仍留汇总审计(可观测扫描已跑)', async () => {
    const REPO2 = uuidv7();
    await enqueueJob(db, { tenantId: TENANT, type: 'security_scan', payload: { tenantId: TENANT, repositoryId: REPO2, trigger: 'scheduled' }, dedupeKey: 'sec-2' });
    await supervisor([]).runOnce();
    const summary = await db.selectFrom('audit_events').selectAll().where('action', '=', 'security.scan').where('target', '=', REPO2).executeTakeFirst();
    expect(summary).toBeDefined();
    expect((summary!.detail as { count: number; trigger: string }).count).toBe(0);
    expect((summary!.detail as { trigger: string }).trigger).toBe('scheduled');
    const findings = await db.selectFrom('audit_events').selectAll().where('action', '=', 'security.finding').where('target', '=', REPO2).execute();
    expect(findings).toHaveLength(0);
  });
});
