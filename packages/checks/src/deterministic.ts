import type { CheckResult, CheckStatus } from './types.js';

export interface DeterministicSignals {
  hasTitleAndDescription: boolean;
  linkedIssue: boolean;
  requiredTestsPresent: boolean;
  unresolvedBlockingFindings: number;
  reviewHealthComplete: boolean;
  requiredDocsPresent: boolean;
  requiredMigrationPresent: boolean;
  approvalsMet: boolean;
}

interface CheckSpec {
  id: string;
  ok: (s: DeterministicSignals) => boolean;
  explain: (s: DeterministicSignals) => string;
}

const SPECS: CheckSpec[] = [
  { id: 'title-description', ok: (s) => s.hasTitleAndDescription, explain: () => 'PR 标题/描述完整' },
  { id: 'linked-issue', ok: (s) => s.linkedIssue, explain: () => '关联 Issue' },
  { id: 'required-tests', ok: (s) => s.requiredTestsPresent, explain: () => '必需测试存在' },
  { id: 'no-unresolved-blocking', ok: (s) => s.unresolvedBlockingFindings === 0, explain: (s) => `未解决 blocking Finding: ${s.unresolvedBlockingFindings}` },
  { id: 'review-health', ok: (s) => s.reviewHealthComplete, explain: () => 'Review 覆盖完整' },
  { id: 'required-docs', ok: (s) => s.requiredDocsPresent, explain: () => '必需文档存在' },
  { id: 'required-migration', ok: (s) => s.requiredMigrationPresent, explain: () => '必需迁移存在' },
  { id: 'approvals', ok: (s) => s.approvalsMet, explain: () => '批准数达标' },
];

export function evaluateDeterministicChecks(signals: DeterministicSignals, revisionSha: string): CheckResult[] {
  return SPECS.map((spec) => {
    const passed = spec.ok(signals);
    const status: CheckStatus = passed ? 'pass' : 'fail';
    return {
      id: spec.id,
      type: 'deterministic',
      status,
      evidence: [],
      explanation: spec.explain(signals),
      revisionSha,
    };
  });
}
