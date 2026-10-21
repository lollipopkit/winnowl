import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { loadEnabledRelationships, proposeRelationship } from '@reviewbot/multi-repo';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import type { AuthContext } from '../src/rbac.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO_A = uuidv7();
const REPO_B = uuidv7();

describe('仓库关系提议/审批(0037)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let admin: FastifyInstance;
  let viewer: FastifyInstance;

  const build = (auth: AuthContext) => buildServer({ quiet: true, db, rbac: { resolveAuth: () => auth } });

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db
      .insertInto('repositories')
      .values([
        { id: REPO_A, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: 'a', namespace: 'acme', name: 'core', clone_url: 'x', default_branch: 'main', created_at: new Date() },
        { id: REPO_B, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: 'b', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() },
      ])
      .execute();
    admin = await build({ role: 'admin', scopes: ['admin'], tenantId: TENANT, actorId: 'admin-sub' });
    viewer = await build({ role: 'viewer', scopes: [], tenantId: TENANT, actorId: 'v-sub' });
    await Promise.all([admin.ready(), viewer.ready()]);
  });

  afterAll(async () => {
    await Promise.all([admin?.close(), viewer?.close()]);
    await stop?.();
  });

  it('propose → proposed 不参与授权(loadEnabledRelationships 忽略)→ approve → active 参与;审计落表', async () => {
    const id = await proposeRelationship(db, TENANT, { sourceRepositoryId: REPO_A, targetRepositoryId: REPO_B, kind: 'library-dependent', proposedBy: 'auto:discover', rationale: 'app depends on npm:core' });
    expect(id).toBeTruthy();
    expect(await loadEnabledRelationships(db, REPO_A)).toHaveLength(0); // proposed grants nothing

    const list = await admin.inject({ method: 'GET', url: '/v1/repository-relationships' });
    const rows = list.json() as { id: string; status: string; rationale?: string }[];
    expect(rows.find((r) => r.id === id)).toMatchObject({ status: 'proposed', rationale: 'app depends on npm:core' });

    const res = await admin.inject({ method: 'POST', url: `/v1/repository-relationships/${id}/approve` });
    expect(res.statusCode).toBe(200);
    const enabled = await loadEnabledRelationships(db, REPO_A);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({ status: 'active', enabled: true });
    const audit = await db.selectFrom('audit_events').select('action').where('target', '=', id!).execute();
    expect(audit.map((a) => a.action)).toContain('cross-repo.relationship-approved');
    // Approving an active relationship -> 404 (only proposed can transition).
    expect((await admin.inject({ method: 'POST', url: `/v1/repository-relationships/${id}/approve` })).statusCode).toBe(404);
  });

  it('reject → 长效否决:不参与授权且重复 propose 被 onConflict 吞掉', async () => {
    const id = await proposeRelationship(db, TENANT, { sourceRepositoryId: REPO_B, targetRepositoryId: REPO_A, kind: 'library-dependent', proposedBy: 'auto:discover', rationale: 'r' });
    const res = await admin.inject({ method: 'POST', url: `/v1/repository-relationships/${id}/reject` });
    expect(res.statusCode).toBe(200);
    expect(await loadEnabledRelationships(db, REPO_B)).toHaveLength(0);
    // Rediscovering a rejected edge does not propose it again.
    const again = await proposeRelationship(db, TENANT, { sourceRepositoryId: REPO_B, targetRepositoryId: REPO_A, kind: 'library-dependent', proposedBy: 'auto:discover', rationale: 'r' });
    expect(again).toBeNull();
  });

  it('viewer 无 config:write → 审批/发现端点 403;discover 入队 relationship_discover job', async () => {
    expect((await viewer.inject({ method: 'POST', url: `/v1/repository-relationships/${uuidv7()}/approve` })).statusCode).toBe(403);
    expect((await viewer.inject({ method: 'POST', url: '/v1/repository-relationships/discover' })).statusCode).toBe(403);
    const res = await admin.inject({ method: 'POST', url: '/v1/repository-relationships/discover' });
    expect(res.statusCode).toBe(200);
    const job = await db.selectFrom('jobs').select(['type', 'payload']).where('type', '=', 'relationship_discover').executeTakeFirst();
    expect(job).toBeTruthy();
    expect((job!.payload as { tenantId: string }).tenantId).toBe(TENANT);
  });
});
