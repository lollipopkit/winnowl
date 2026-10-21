import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createInstallationErasureHandler, createRetentionSweepHandler } from '../src/retention.js';
import type { JobContext } from '../src/supervisor.js';

const TENANT = uuidv7();

/** Langfuse erasure stand-in: records the metadata filter and can be set to always fail. */
function fakeEraser(opts: { fail?: boolean } = {}) {
  const calls: { key: string; value: string }[][] = [];
  return {
    calls,
    eraseByMetadata: async (matches: { key: string; value: string }[]) => {
      calls.push(matches);
      if (opts.fail) throw new Error('langfuse down');
      return matches.length;
    },
  };
}

const noopSandbox: SandboxBackend = {
  create: async () => ({ id: 's', containerId: 'c' }),
  exec: async () => {
    throw new Error('unused');
  },
  putFile: async () => undefined,
  getArtifact: async () => ({ path: '', content: '', bytes: 0 }),
  destroy: async () => undefined,
};

function ctxFor(db: Db, payload: Record<string, unknown>): JobContext {
  return { job: { payload } as unknown as JobContext['job'], db, sandbox: noopSandbox, log: () => undefined };
}

describe('§43 retention/erasure handlers(租户开放 P0)', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  it('retention_sweep:过期 artifact 先删对象再删行;对象删失败保留行;未过期不动', async () => {
    const mk = (id: string, key: string, expires: Date | null) =>
      db.insertInto('artifacts').values({ id, tenant_id: TENANT, kind: 'fix-patch', storage_key: key, content_type: null, size_bytes: 1, sha256: 'x', encrypted: false, expires_at: expires, metadata: JSON.stringify({}), created_at: new Date() }).execute();
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 86_400_000);
    const A = uuidv7();
    const B = uuidv7();
    const C = uuidv7();
    await mk(A, 'k/expired-ok', past);
    await mk(B, 'k/expired-store-fail', past);
    await mk(C, 'k/fresh', future);

    const deleted: string[] = [];
    const store = {
      put: async () => undefined,
      get: async () => Buffer.from(''),
      delete: async (key: string) => {
        if (key === 'k/expired-store-fail') throw new Error('s3 down');
        deleted.push(key);
      },
    };
    await createRetentionSweepHandler({ store })(ctxFor(db, { tenantId: TENANT }));

    const rows = await db.selectFrom('artifacts').select(['id']).where('tenant_id', '=', TENANT).execute();
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(A); // object deleted → row deleted
    expect(ids).toContain(B); // object delete failed → row kept for the next run
    expect(ids).toContain(C); // not expired: untouched
    expect(deleted).toEqual(['k/expired-ok']);
  });

  it('retention_sweep: review_progress by finished_at; unfinished rows only after the abandoned cutoff on updated_at', async () => {
    const HOST = uuidv7();
    const INSTALL = uuidv7();
    const REPO = uuidv7();
    const CR = uuidv7();
    const OTHER_TENANT = uuidv7();
    await db.insertInto('tenants').values({ id: OTHER_TENANT, name: 'other', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '7', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '70', namespace: 'acme', name: 'progress', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    await db.insertInto('change_requests').values({ id: CR, tenant_id: TENANT, repository_id: REPO, native_id: '7', number: 7, kind: 'pull-request', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() }).execute();

    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    const mk = async (opts: { tenantId?: string; updatedAt: Date; finishedAt: Date | null }) => {
      const id = uuidv7();
      const tenantId = opts.tenantId ?? TENANT;
      await db.insertInto('jobs').values({ id, tenant_id: tenantId, type: 'review_revision', status: 'running', payload: JSON.stringify({}) as unknown as Record<string, unknown>, runner_selector: JSON.stringify({}) as unknown as Record<string, unknown>, created_at: new Date() }).execute();
      await db.insertInto('review_progress').values({ job_id: id, tenant_id: tenantId, repository_id: REPO, change_request_id: CR, revision_id: uuidv7(), stage: opts.finishedAt ? 'done' : 'dig', done: null, total: null, attempt: 1, started_at: opts.updatedAt, updated_at: opts.updatedAt, finished_at: opts.finishedAt }).execute();
      return id;
    };
    const finishedOld = await mk({ updatedAt: daysAgo(31), finishedAt: daysAgo(31) });
    const finishedRecent = await mk({ updatedAt: daysAgo(29), finishedAt: daysAgo(29) });
    // Unfinished and idle past the finished window, but short of the abandoned cutoff: must stay.
    const unfinishedIdle = await mk({ updatedAt: daysAgo(60), finishedAt: null });
    const unfinishedAbandoned = await mk({ updatedAt: daysAgo(91), finishedAt: null });
    const unfinishedLive = await mk({ updatedAt: new Date(), finishedAt: null });
    // Another tenant's expired row: this tenant's sweep must not touch it.
    const otherTenantOld = await mk({ tenantId: OTHER_TENANT, updatedAt: daysAgo(31), finishedAt: daysAgo(31) });

    await createRetentionSweepHandler()(ctxFor(db, { tenantId: TENANT }));

    const ids = (await db.selectFrom('review_progress').select('job_id').execute()).map((r) => r.job_id);
    expect(ids).not.toContain(finishedOld);
    expect(ids).not.toContain(unfinishedAbandoned);
    expect(ids).toEqual(expect.arrayContaining([finishedRecent, unfinishedIdle, unfinishedLive, otherTenantOld]));
  });

  it('installation_erasure:FK 级联清空安装数据 + audit 擦除证明;重复执行幂等', async () => {
    const HOST = uuidv7();
    const INSTALL = uuidv7();
    const REPO = uuidv7();
    const CR = uuidv7();
    const F = uuidv7();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '9', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '90', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    await db.insertInto('change_requests').values({ id: CR, tenant_id: TENANT, repository_id: REPO, native_id: '1', number: 1, kind: 'pull-request', source_branch: 'f', target_branch: 'main', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() }).execute();
    await db.insertInto('findings').values({ id: F, tenant_id: TENANT, repository_id: REPO, first_seen_at: new Date(), last_seen_at: new Date(), canonical_claim: 'bug', lifecycle: 'new', semantic_fingerprint: 'fp', category: 'correctness' }).execute();

    const handler = createInstallationErasureHandler();
    await handler(ctxFor(db, { tenantId: TENANT, installationId: INSTALL }));

    expect(await db.selectFrom('installations').select('id').where('id', '=', INSTALL).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('repositories').select('id').where('id', '=', REPO).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('change_requests').select('id').where('id', '=', CR).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('findings').select('id').where('id', '=', F).executeTakeFirst()).toBeUndefined();
    const audit = await db.selectFrom('audit_events').selectAll().where('action', '=', 'retention.installation-erased').executeTakeFirstOrThrow();
    const proof = audit.detail as { erasedCounts?: Record<string, number>; status?: string };
    expect(proof.status).toBe('completed');
    expect(proof.erasedCounts).toMatchObject({ checkout: 1, 'review-artifacts': 1, 'finding-metadata': 1 });

    // Idempotent: a second run neither throws nor writes audit.
    await handler(ctxFor(db, { tenantId: TENANT, installationId: INSTALL }));
    const audits = await db.selectFrom('audit_events').select('id').where('action', '=', 'retention.installation-erased').execute();
    expect(audits).toHaveLength(1);
  });

  /** With `LLM_TRACE_BODIES`, Langfuse stores customer source, so erasure must cover it too. */
  describe('installation_erasure × Langfuse trace 擦除', () => {
    const mkInstall = async () => {
      const HOST = uuidv7();
      const INSTALL = uuidv7();
      const REPO = uuidv7();
      await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
      await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '9', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
      await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '90', namespace: 'acme', name: 'web', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
      return { HOST, INSTALL, REPO };
    };

    it('按 installation 擦 trace,条数进擦除证明', async () => {
      const { INSTALL } = await mkInstall();
      const langfuse = fakeEraser();
      await createInstallationErasureHandler({ langfuse })(ctxFor(db, { tenantId: TENANT, installationId: INSTALL }));

      expect(langfuse.calls).toEqual([[{ key: 'installation', value: INSTALL }]]);
      const audit = await db.selectFrom('audit_events').selectAll().where('target', '=', INSTALL).executeTakeFirstOrThrow();
      const detail = audit.detail as { erasedCounts?: Record<string, number>; llmTraces?: { backend: string | null; tracesRequested: number | null } };
      expect(detail.erasedCounts?.['llm-traces']).toBe(1);
      expect(detail.llmTraces).toEqual({ backend: 'langfuse', tracesRequested: 1 });
    });

    it('Langfuse 擦除失败 → 抛错且**不删库**(重试才能补上;删了库就再也补不了)', async () => {
      const { INSTALL, REPO } = await mkInstall();
      const langfuse = fakeEraser({ fail: true });
      await expect(createInstallationErasureHandler({ langfuse })(ctxFor(db, { tenantId: TENANT, installationId: INSTALL }))).rejects.toThrow('langfuse down');

      expect(await db.selectFrom('installations').select('id').where('id', '=', INSTALL).executeTakeFirst()).toBeTruthy();
      expect(await db.selectFrom('repositories').select('id').where('id', '=', REPO).executeTakeFirst()).toBeTruthy();
      expect(await db.selectFrom('audit_events').select('id').where('target', '=', INSTALL).executeTakeFirst()).toBeUndefined();

      // The backend recovers: the retry runs the full path.
      const ok = fakeEraser();
      await createInstallationErasureHandler({ langfuse: ok })(ctxFor(db, { tenantId: TENANT, installationId: INSTALL }));
      expect(await db.selectFrom('installations').select('id').where('id', '=', INSTALL).executeTakeFirst()).toBeUndefined();
      expect(ok.calls).toHaveLength(1);
    });

    it('库里已擦干净的安装,重投仍去擦 Langfuse(补本条上线前卸载的那些)', async () => {
      const GONE = uuidv7();
      const langfuse = fakeEraser();
      await createInstallationErasureHandler({ langfuse })(ctxFor(db, { tenantId: TENANT, installationId: GONE }));
      // The repository list is gone with the database; only the installation remains as a key.
      expect(langfuse.calls).toEqual([[{ key: 'installation', value: GONE }]]);
    });

    it('未接 Langfuse → 证明里 backend=null(与「接了但零条」区分开)', async () => {
      const { INSTALL } = await mkInstall();
      await createInstallationErasureHandler()(ctxFor(db, { tenantId: TENANT, installationId: INSTALL }));
      const audit = await db.selectFrom('audit_events').selectAll().where('target', '=', INSTALL).executeTakeFirstOrThrow();
      const detail = audit.detail as { erasedCounts?: Record<string, number>; llmTraces?: { backend: string | null; tracesRequested: number | null } };
      expect(detail.llmTraces).toEqual({ backend: null, tracesRequested: null });
      expect(detail.erasedCounts?.['llm-traces']).toBeUndefined();
    });
  });
});
