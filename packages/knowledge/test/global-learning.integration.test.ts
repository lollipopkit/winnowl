import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  aggregateCrossTenantLearnings,
  aggregateRecurringFeedback,
  aggregateRecurringFindings,
  globalLearningExists,
  insertGlobalLearning,
  insertLearningProposal,
  loadGlobalLearning,
  newGlobalLearning,
  newProposal,
  transitionAndPersist,
  type GlobalLearningDeliberation,
} from '../src/index.js';

// Two tenants, each with its own host/install/repo, for cross-tenant aggregation.
const T1 = uuidv7();
const T2 = uuidv7();
const admin = { isTenantAdmin: true, ref: 'admin' };

async function seedTenant(db: Db, tenantId: string): Promise<string> {
  const host = uuidv7();
  const install = uuidv7();
  const repo = uuidv7();
  await db.insertInto('tenants').values({ id: tenantId, name: tenantId.slice(0, 6), region: null, created_at: new Date() }).execute();
  await db.insertInto('provider_hosts').values({ id: host, tenant_id: tenantId, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
  await db.insertInto('installations').values({ id: install, tenant_id: tenantId, provider_host_id: host, native_id: '1', account_login: 'a', status: 'active', created_at: new Date() }).execute();
  await db.insertInto('repositories').values({ id: repo, tenant_id: tenantId, provider_host_id: host, installation_id: install, native_id: '1', namespace: 'a', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
  return repo;
}

async function seedFinding(db: Db, tenantId: string, repoId: string, claim: string, category = 'correctness'): Promise<void> {
  await db
    .insertInto('findings')
    .values({
      id: uuidv7(),
      tenant_id: tenantId,
      repository_id: repoId,
      semantic_fingerprint: `fp-${claim}-${tenantId.slice(0, 4)}`,
      category,
      canonical_claim: claim,
      lifecycle: 'published',
      first_seen_at: new Date(),
      last_seen_at: new Date(),
    })
    .execute();
}

describe('global learning 聚合 + 存储(§多模型自动提议)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let repo1: string;
  let repo2: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    repo1 = await seedTenant(db, T1);
    repo2 = await seedTenant(db, T2);

    // "SHARED" recurs across tenants; "T1-ONLY" is T1's alone.
    await seedFinding(db, T1, repo1, 'SHARED');
    await seedFinding(db, T2, repo2, 'SHARED');
    await seedFinding(db, T1, repo1, 'T1-ONLY');

    for (const [t, r] of [[T1, repo1], [T2, repo2]] as const) {
      await db.insertInto('feedbacks').values({ id: uuidv7(), tenant_id: t, repository_id: r, fingerprint: 'fp', finding_id: null, class: 'false-positive', actor: 'bob', created_at: new Date() }).execute();
    }

    for (const [t, r] of [[T1, repo1], [T2, repo2]] as const) {
      const p = newProposal({ repositoryId: r, instruction: '始终校验租户作用域', rationale: 'r', proposedBy: 'agent' });
      await insertLearningProposal(db, t, p);
      await transitionAndPersist(db, t, p.id, { action: 'approve', actor: admin });
    }
  });

  afterAll(async () => {
    await stop?.();
  });

  it('aggregateRecurringFindings:SHARED 跨 2 租户,T1-ONLY 仅 1', async () => {
    const rows = await aggregateRecurringFindings(db, {});
    const shared = rows.find((r) => r.claim === 'SHARED');
    const only = rows.find((r) => r.claim === 'T1-ONLY');
    expect(shared?.tenants).toBe(2);
    expect(shared?.occurrences).toBe(2);
    expect(only?.tenants).toBe(1);
  });

  it('aggregateRecurringFeedback:false-positive 跨 2 租户', async () => {
    const rows = await aggregateRecurringFeedback(db, {});
    expect(rows.find((r) => r.class === 'false-positive')?.tenants).toBe(2);
  });

  it('aggregateCrossTenantLearnings:相同 instruction 跨 2 租户(≥2 才入)', async () => {
    const rows = await aggregateCrossTenantLearnings(db, {});
    expect(rows.find((r) => r.instruction === '始终校验租户作用域')?.tenants).toBe(2);
  });

  it('global-store:auto 提议 + deliberation 往返;去重', async () => {
    const deliberation: GlobalLearningDeliberation = {
      signal: { kind: 'design', note: 'good pattern' },
      evidence: ['SHARED recurs across 2 tenants'],
      draftModel: 'model-x',
      panel: [
        { model: 'a', decision: 'approve', confidence: 0.9, reasoning: 'general' },
        { model: 'b', decision: 'approve', confidence: 0.8, reasoning: 'ok' },
        { model: 'c', decision: 'reject', confidence: 0.6, reasoning: 'too specific' },
      ],
      aggregate: { confidence: 0.567, approvals: 2, total: 3 },
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
    };
    const g = newGlobalLearning({ instruction: '自动全局规则 X', rationale: 'r', proposedBy: 'system', origin: 'auto', confidence: 0.567, deliberation });
    await insertGlobalLearning(db, g);

    const loaded = await loadGlobalLearning(db, g.id);
    expect(loaded).toMatchObject({ origin: 'auto', confidence: 0.567, status: 'proposed', proposedBy: 'system' });
    expect(loaded!.deliberation!.panel).toHaveLength(3);
    expect(loaded!.deliberation!.panel[2]).toMatchObject({ model: 'c', decision: 'reject' });

    expect(await globalLearningExists(db, '自动全局规则 X')).toBe(true);
    expect(await globalLearningExists(db, '  自动全局规则 X  ')).toBe(true); // normalised
    expect(await globalLearningExists(db, '别的规则')).toBe(false);
  });
});
