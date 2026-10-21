import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  insertFeedback,
  insertGlobalLearning,
  insertLearningProposal,
  listLearningProposals,
  loadApplicableKnowledge,
  loadApprovedKnowledge,
  loadFeedbackFor,
  loadLearningProposal,
  markLearningsUsed,
  maybeAutoProposeLearning,
  newGlobalLearning,
  newProposal,
  orderKnowledge,
  transitionAndPersist,
  transitionGlobalLearning,
} from '../src/index.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const admin = { isTenantAdmin: true, ref: 'alice' };
const nonAdmin = { isTenantAdmin: false, ref: 'bob' };

describe('Learning Proposal 持久化', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '1', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  async function seed(): Promise<string> {
    const p = newProposal({ repositoryId: REPO, locality: 'path', selector: 'src/**', instruction: '用 X', rationale: '因为 Y', proposedBy: 'agent' });
    await insertLearningProposal(db, TENANT, p);
    return p.id;
  }

  it('insert → load 往返', async () => {
    const id = await seed();
    const loaded = await loadLearningProposal(db, TENANT, id);
    expect(loaded).toMatchObject({ repositoryId: REPO, locality: 'path', selector: 'src/**', instruction: '用 X', status: 'proposed', version: 1 });
  });

  it('Admin approve → approved,version+1,记审批人', async () => {
    const id = await seed();
    const r = await transitionAndPersist(db, TENANT, id, { action: 'approve', actor: admin, now: 1000 });
    expect(r.ok).toBe(true);
    const loaded = await loadLearningProposal(db, TENANT, id);
    expect(loaded).toMatchObject({ status: 'approved', approvedBy: 'alice', version: 2 });
  });

  it('非 Admin approve → 拒绝,不改状态', async () => {
    const id = await seed();
    const r = await transitionAndPersist(db, TENANT, id, { action: 'approve', actor: nonAdmin });
    expect(r.ok).toBe(false);
    expect((await loadLearningProposal(db, TENANT, id))!.status).toBe('proposed');
  });

  it('未知 proposal → not found', async () => {
    expect((await transitionAndPersist(db, TENANT, uuidv7(), { action: 'approve', actor: admin })).reason).toBe('proposal not found');
  });

  it('list 与 status 过滤', async () => {
    const all = await listLearningProposals(db, TENANT);
    expect(all.length).toBeGreaterThan(0);
    const approved = await listLearningProposals(db, TENANT, { status: 'approved' });
    expect(approved.every((p) => p.status === 'approved')).toBe(true);
    const open = await listLearningProposals(db, TENANT, { status: ['proposed', 'approved'] });
    expect(open.every((p) => p.status === 'proposed' || p.status === 'approved')).toBe(true);
  });

  it('list 不截断:超过 200 条已批准规则全部返回(评审注入依赖完整集合)', async () => {
    const T = uuidv7();
    await db.insertInto('tenants').values({ id: T, name: 'many-rules', region: null, created_at: new Date() }).execute();
    for (let i = 0; i < 205; i++) {
      const p = newProposal({ repositoryId: null, broadness: 'organization', instruction: `rule ${i}`, rationale: 'r', proposedBy: 'agent' });
      await insertLearningProposal(db, T, { ...p, status: 'approved' });
    }
    expect(await listLearningProposals(db, T, { status: 'approved' })).toHaveLength(205);
  });

  it('markLearningsUsed:usage_count 自增 + last_used_at(§使用统计 0038)', async () => {
    const p = newProposal({ repositoryId: REPO, instruction: 'used rule', rationale: 'r', proposedBy: 'agent' });
    await insertLearningProposal(db, TENANT, p);
    expect((await loadLearningProposal(db, TENANT, p.id))!.usageCount).toBe(0);
    await markLearningsUsed(db, [p.id], 5000);
    await markLearningsUsed(db, [p.id], 6000);
    const loaded = await loadLearningProposal(db, TENANT, p.id);
    expect(loaded!.usageCount).toBe(2);
    expect(loaded!.lastUsedAt).toBe(6000);
    await markLearningsUsed(db, []);
  });

  it('loadApprovedKnowledge:仅 approved+本仓;orderKnowledge 无 path 只留 repository scope(§31.5)', async () => {
    const repoScope = newProposal({ repositoryId: REPO, instruction: '始终校验租户作用域', rationale: 'r', proposedBy: 'agent' });
    const pathScope = newProposal({ repositoryId: REPO, locality: 'path', selector: 'src/**', instruction: '此目录用 X', rationale: 'r', proposedBy: 'agent' });
    await insertLearningProposal(db, TENANT, repoScope);
    await insertLearningProposal(db, TENANT, pathScope);
    await transitionAndPersist(db, TENANT, repoScope.id, { action: 'approve', actor: admin });
    await transitionAndPersist(db, TENANT, pathScope.id, { action: 'approve', actor: admin });

    const items = await loadApprovedKnowledge(db, TENANT, REPO);
    // The unapproved seed proposal is excluded.
    expect(items.filter((i) => i.id === repoScope.id || i.id === pathScope.id)).toHaveLength(2);
    expect(items.every((i) => i.category === 'approved-learning')).toBe(true);

    // Without path context, path-scoped items are dropped and repository-scoped kept.
    const ordered = orderKnowledge(items);
    expect(ordered.some((i) => i.id === repoScope.id)).toBe(true);
    expect(ordered.some((i) => i.id === pathScope.id)).toBe(false);
  });

  it('loadApplicableKnowledge:org(跨仓)+ repo(本仓)并集,别仓不入,specificity repo>org(§P2)', async () => {
    const REPO2 = uuidv7();
    await db.insertInto('repositories').values({ id: REPO2, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '2', namespace: 'acme', name: 'app2', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    const org = newProposal({ repositoryId: null, broadness: 'organization', instruction: 'ORG-规则', rationale: 'r', proposedBy: 'admin' });
    const repoL = newProposal({ repositoryId: REPO, instruction: 'REPO-规则', rationale: 'r', proposedBy: 'admin' });
    const other = newProposal({ repositoryId: REPO2, instruction: 'OTHER-规则', rationale: 'r', proposedBy: 'admin' });
    for (const p of [org, repoL, other]) await insertLearningProposal(db, TENANT, p);
    await transitionAndPersist(db, TENANT, org.id, { action: 'approve', actor: admin });
    await transitionAndPersist(db, TENANT, repoL.id, { action: 'approve', actor: admin });
    await transitionAndPersist(db, TENANT, other.id, { action: 'approve', actor: admin });

    const items = await loadApplicableKnowledge(db, { tenantId: TENANT, repositoryId: REPO });
    const contents = items.map((i) => i.content);
    expect(contents).toContain('ORG-规则');
    expect(contents).toContain('REPO-规则');
    expect(contents).not.toContain('OTHER-规则');
    const orgItem = items.find((i) => i.content === 'ORG-规则')!;
    const repoItem = items.find((i) => i.content === 'REPO-规则')!;
    expect(repoItem.specificity!).toBeGreaterThan(orgItem.specificity!);
  });

  it('global 广度:platform-operator approve → 对任一仓注入,specificity 最低 + mandatory(§P3)', async () => {
    const g = newGlobalLearning({ instruction: 'GLOBAL-规则', rationale: 'r', proposedBy: 'op', enforcement: 'mandatory' });
    await insertGlobalLearning(db, g);
    // A tenant admin who is not an operator cannot approve global learnings.
    const denied = await transitionGlobalLearning(db, g.id, { action: 'approve', actor: { isTenantAdmin: true, ref: 'x' } });
    expect(denied.ok).toBe(false);
    const okd = await transitionGlobalLearning(db, g.id, { action: 'approve', actor: { isTenantAdmin: false, isPlatformOperator: true, ref: 'op' } });
    expect(okd.ok).toBe(true);

    const items = await loadApplicableKnowledge(db, { tenantId: TENANT, repositoryId: REPO });
    const gi = items.find((i) => i.content === 'GLOBAL-规则');
    expect(gi).toBeTruthy();
    expect(gi!.mandatory).toBe(true);
    expect(gi!.specificity).toBe(0); // global/none is lowest, below org (3) / repo (6)
  });

  it('user 广度:subject_ref 命中 PR 参与者才注入,specificity 最高(§P4)', async () => {
    const u = newProposal({ repositoryId: null, broadness: 'user', subjectRef: 'github:1001', instruction: 'USER-规则', rationale: 'r', proposedBy: 'admin' });
    await insertLearningProposal(db, TENANT, u);
    await transitionAndPersist(db, TENANT, u.id, { action: 'approve', actor: admin });

    const withP = await loadApplicableKnowledge(db, { tenantId: TENANT, repositoryId: REPO, participants: ['github:1001'] });
    const ui = withP.find((i) => i.content === 'USER-规则');
    expect(ui).toBeTruthy();
    expect(ui!.specificity).toBe(9); // user/none is highest

    const without = await loadApplicableKnowledge(db, { tenantId: TENANT, repositoryId: REPO });
    expect(without.map((i) => i.content)).not.toContain('USER-规则');
    const other = await loadApplicableKnowledge(db, { tenantId: TENANT, repositoryId: REPO, participants: ['github:mallory'] });
    expect(other.map((i) => i.content)).not.toContain('USER-规则');
  });

  it('反馈达阈值 → maybeAutoProposeLearning 产 proposed(绝不 approved);注入文本被拦(§P5)', async () => {
    const fp = 'fp-p5';
    const before = await maybeAutoProposeLearning(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fp, claim: '某噪音发现' }, { threshold: 3 });
    expect(before.proposed).toBe(false);

    for (let i = 0; i < 3; i++) await insertFeedback(db, TENANT, { repositoryId: REPO, fingerprint: fp, class: 'false-positive', actor: 'bob' });
    expect(await loadFeedbackFor(db, TENANT, { repositoryId: REPO, fingerprint: fp })).toHaveLength(3);

    const res = await maybeAutoProposeLearning(db, { tenantId: TENANT, repositoryId: REPO, fingerprint: fp, claim: '某噪音发现' }, { threshold: 3 });
    expect(res.proposed).toBe(true);
    const p = await loadLearningProposal(db, TENANT, res.proposalId!);
    expect(p!.status).toBe('proposed'); // never auto-approved
    expect(p!.proposedBy).toBe('auto');

    // Injection guard hit: blocked, not persisted.
    const blocked = await maybeAutoProposeLearning(
      db,
      { tenantId: TENANT, repositoryId: REPO, fingerprint: fp, claim: 'x' },
      { threshold: 3, isSuspicious: () => true },
    );
    expect(blocked.proposed).toBe(false);
    expect(blocked.blocked).toBe(true);
  });
});
