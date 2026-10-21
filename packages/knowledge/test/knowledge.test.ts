import { describe, expect, it } from 'vitest';
import {
  aggregatePanel,
  collectAuthoritativeRules,
  isLearningActive,
  matchesGlob,
  orderKnowledge,
  orderKnowledgeForPaths,
  shouldProposeFromFeedback,
  transitionLearning,
  type LearningProposal,
  type RetrievalItem,
} from '../src/index.js';

describe('aggregatePanel(§global 多模型互审汇总)', () => {
  it('全票 approve → confidence = approve 均值(通过率 1)', () => {
    const r = aggregatePanel([
      { model: 'a', decision: 'approve', confidence: 0.9, reasoning: '' },
      { model: 'b', decision: 'approve', confidence: 0.8, reasoning: '' },
      { model: 'c', decision: 'approve', confidence: 1.0, reasoning: '' },
    ]);
    expect(r).toEqual({ confidence: 0.9, approvals: 3, total: 3 });
  });
  it('部分 approve → 通过率折减(0.5 × 0.9)', () => {
    const r = aggregatePanel([
      { model: 'a', decision: 'approve', confidence: 0.9, reasoning: '' },
      { model: 'b', decision: 'reject', confidence: 0.9, reasoning: '' },
    ]);
    expect(r).toEqual({ confidence: 0.45, approvals: 1, total: 2 });
  });
  it('空票 → 0;confidence 越界 clamp 到 [0,1]', () => {
    expect(aggregatePanel([])).toEqual({ confidence: 0, approvals: 0, total: 0 });
    expect(aggregatePanel([{ model: 'a', decision: 'approve', confidence: 5, reasoning: '' }]).confidence).toBe(1);
  });
});

describe('collectAuthoritativeRules', () => {
  it('带来源+优先级,按优先级降序', () => {
    const rules = collectAuthoritativeRules([
      { instruction: 'readme rule', source: 'readme-docs' },
      { instruction: 'org rule', source: 'org-policy' },
      { instruction: 'yaml rule', source: 'reviewbot-yaml', selector: 'src/**' },
    ]);
    expect(rules.map((r) => r.source)).toEqual(['org-policy', 'reviewbot-yaml', 'readme-docs']);
    expect(rules[0]!.priority).toBeGreaterThan(rules[1]!.priority);
    expect(rules.find((r) => r.source === 'reviewbot-yaml')?.selector).toBe('src/**');
  });
});

describe('transitionLearning', () => {
  const base: LearningProposal = {
    id: 'l1', repositoryId: 'r1', broadness: 'repository', locality: 'none', enforcement: 'default',
    instruction: '用 X', rationale: '因为 Y', proposedBy: 'agent', status: 'proposed', version: 1,
  };
  const admin = { isTenantAdmin: true, ref: 'alice' };
  const nonAdmin = { isTenantAdmin: false, ref: 'bob' };

  it('非 Admin 不能 approve', () => {
    expect(transitionLearning(base, { action: 'approve', actor: nonAdmin }).ok).toBe(false);
  });
  it('tenant-scoped breadths (organization/user) are approved by the tenant admin; global only by a platform operator', () => {
    for (const broadness of ['organization', 'user'] as const) {
      const p: LearningProposal = { ...base, broadness, repositoryId: null };
      expect(transitionLearning(p, { action: 'approve', actor: nonAdmin }).ok).toBe(false);
      expect(transitionLearning(p, { action: 'approve', actor: admin }).proposal?.status).toBe('approved');
    }
    const global: LearningProposal = { ...base, broadness: 'global', repositoryId: null };
    expect(transitionLearning(global, { action: 'approve', actor: admin }).ok).toBe(false);
    expect(transitionLearning(global, { action: 'approve', actor: { isTenantAdmin: false, isPlatformOperator: true, ref: 'op' } }).ok).toBe(true);
  });
  it('a repository forge admin approves only that repository; a user only learnings about themselves', () => {
    const repoAdmin = { isTenantAdmin: false, repositoryAdminOf: 'r1', ref: 'carol' };
    expect(transitionLearning(base, { action: 'approve', actor: repoAdmin }).proposal?.status).toBe('approved');
    expect(transitionLearning({ ...base, repositoryId: 'r2' }, { action: 'approve', actor: repoAdmin }).ok).toBe(false);
    const org: LearningProposal = { ...base, broadness: 'organization', repositoryId: null };
    expect(transitionLearning(org, { action: 'approve', actor: repoAdmin }).ok).toBe(false);
    const mine: LearningProposal = { ...base, broadness: 'user', repositoryId: null, subjectRef: 'github:7' };
    expect(transitionLearning(mine, { action: 'approve', actor: { isTenantAdmin: false, subjectRef: 'github:7', ref: 'dan' } }).ok).toBe(true);
    expect(transitionLearning(mine, { action: 'approve', actor: { isTenantAdmin: false, subjectRef: 'github:8', ref: 'eve' } }).ok).toBe(false);
  });
  it('Admin approve:proposed→approved,记录审批人与版本', () => {
    const r = transitionLearning(base, { action: 'approve', actor: admin, now: 1000 });
    expect(r.ok).toBe(true);
    expect(r.proposal).toMatchObject({ status: 'approved', approvedBy: 'alice', approvedAt: 1000, version: 2 });
  });
  it('已 approved 不能再 approve;可 revoke(仅 Admin)', () => {
    const approved = transitionLearning(base, { action: 'approve', actor: admin }).proposal!;
    expect(transitionLearning(approved, { action: 'approve', actor: admin }).ok).toBe(false);
    expect(transitionLearning(approved, { action: 'revoke', actor: nonAdmin }).ok).toBe(false);
    expect(transitionLearning(approved, { action: 'revoke', actor: admin }).proposal?.status).toBe('revoked');
  });
  it('expire 仅在到期后', () => {
    const approved: LearningProposal = { ...base, status: 'approved', expiresAt: 5000, version: 2 };
    expect(transitionLearning(approved, { action: 'expire', now: 4000 }).ok).toBe(false);
    expect(transitionLearning(approved, { action: 'expire', now: 6000 }).proposal?.status).toBe('expired');
  });
  it('isLearningActive:approved 且未过期', () => {
    expect(isLearningActive({ ...base, status: 'approved', version: 2 })).toBe(true);
    expect(isLearningActive({ ...base, status: 'approved', expiresAt: 100, version: 2 }, 200)).toBe(false);
    expect(isLearningActive(base)).toBe(false);
  });
});

describe('shouldProposeFromFeedback', () => {
  it('单次 dismiss 不成规则', () => {
    const d = shouldProposeFromFeedback([{ class: 'false-positive' }]);
    expect(d.propose).toBe(false);
  });
  it('重复模式达阈值 → 提案', () => {
    const d = shouldProposeFromFeedback([{ class: 'false-positive' }, { class: 'false-positive' }, { class: 'not-important' }]);
    expect(d.propose).toBe(true);
    expect(d.count).toBe(3);
  });
  it('accepted/fixed 等不计入规则提案', () => {
    const d = shouldProposeFromFeedback([{ class: 'accepted' }, { class: 'fixed' }, { class: 'duplicate' }]);
    expect(d.propose).toBe(false);
  });
});

describe('orderKnowledge', () => {
  const items: RetrievalItem[] = [
    { id: 'e', category: 'external-context', content: 'ext' },
    { id: 'a', category: 'authoritative-rule', content: 'auth' },
    { id: 'l', category: 'approved-learning', content: 'learn' },
  ];
  it('按检索顺序排序', () => {
    expect(orderKnowledge(items).map((i) => i.id)).toEqual(['a', 'l', 'e']);
  });
  it('剔除过期项', () => {
    const withExpired: RetrievalItem[] = [...items, { id: 'x', category: 'approved-learning', content: 'stale', expiresAt: 100 }];
    expect(orderKnowledge(withExpired, { now: 200 }).some((i) => i.id === 'x')).toBe(false);
  });
  it('适用性:selector 匹配当前 path 才保留', () => {
    const scoped: RetrievalItem[] = [
      { id: 's1', category: 'approved-learning', content: 'src rule', selector: 'src/**' },
      { id: 's2', category: 'approved-learning', content: 'test rule', selector: 'test/**' },
    ];
    const out = orderKnowledge(scoped, { path: 'src/a/b.ts' });
    expect(out.map((i) => i.id)).toEqual(['s1']);
    // Selector without path context is dropped.
    expect(orderKnowledge(scoped, {})).toHaveLength(0);
  });
});

describe('orderKnowledgeForPaths', () => {
  const items: RetrievalItem[] = [
    { id: 'g', category: 'authoritative-rule', content: 'global' },
    { id: 's1', category: 'approved-learning', content: 'src rule', selector: 'src/**' },
    { id: 's2', category: 'approved-learning', content: 'test rule', selector: 'test/**' },
  ];
  it('全局项 + selector 命中任一变更文件的 path scope 项纳入', () => {
    const out = orderKnowledgeForPaths(items, ['src/a/b.ts', 'README.md']);
    expect(out.map((i) => i.id).sort()).toEqual(['g', 's1']);
  });
  it('空 paths → 仅全局项', () => {
    expect(orderKnowledgeForPaths(items, []).map((i) => i.id)).toEqual(['g']);
  });
  it('剔除过期项', () => {
    const withExpired: RetrievalItem[] = [...items, { id: 'x', category: 'approved-learning', content: 'stale', selector: 'src/**', expiresAt: 100 }];
    expect(orderKnowledgeForPaths(withExpired, ['src/x.ts'], { now: 200 }).some((i) => i.id === 'x')).toBe(false);
  });
});

describe('matchesGlob(`**/` 零层目录,minimatch 语义)', () => {
  it('`**/*.lock` 命中顶层与嵌套', () => {
    expect(matchesGlob('**/*.lock', 'pubspec.lock')).toBe(true);
    expect(matchesGlob('**/*.lock', 'macos/Podfile.lock')).toBe(true);
    expect(matchesGlob('**/*.lock', 'a/b/Cargo.lock')).toBe(true);
    expect(matchesGlob('**/*.lock', 'src/lock.ts')).toBe(false);
  });
  it('`**/dist/**` 命中顶层 dist 与嵌套 dist', () => {
    expect(matchesGlob('**/dist/**', 'dist/x.js')).toBe(true);
    expect(matchesGlob('**/dist/**', 'apps/web/dist/x.js')).toBe(true);
    expect(matchesGlob('**/dist/**', 'distx/x.js')).toBe(false);
  });
  it('中段 `**/` 亦可折叠为零层;`*` 仍不跨段', () => {
    expect(matchesGlob('src/**/x.ts', 'src/x.ts')).toBe(true);
    expect(matchesGlob('src/**/x.ts', 'src/a/b/x.ts')).toBe(true);
    expect(matchesGlob('src/*.ts', 'src/a/x.ts')).toBe(false);
  });
});
