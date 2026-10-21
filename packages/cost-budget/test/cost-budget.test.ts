import { describe, expect, it } from 'vitest';
import {
  adaptBudget,
  budgetExceeded,
  classifyChangeRisk,
  computeCostPerReview,
  computeRiskFactor,
  DEFAULT_BUDGET,
  type BudgetConsumption,
} from '../src/index.js';

describe('adaptBudget', () => {
  it('高风险增加预算(每项 +25%,上限 3×)', () => {
    const b = adaptBudget(DEFAULT_BUDGET, { highRisk: ['auth-security', 'concurrency'] });
    expect(b.maxAgentInvocations).toBe(Math.round(DEFAULT_BUDGET.maxAgentInvocations * 1.5));
    const capped = adaptBudget(DEFAULT_BUDGET, { highRisk: Array(20).fill('migration') });
    expect(capped.maxScopes).toBe(DEFAULT_BUDGET.maxScopes * 3);
  });
  it('仅低风险时降低预算(0.5×)', () => {
    const b = adaptBudget(DEFAULT_BUDGET, { lowRisk: ['docs'] });
    expect(b.maxAgentInvocations).toBe(Math.round(DEFAULT_BUDGET.maxAgentInvocations * 0.5));
  });
  it('高风险优先于低风险', () => {
    const b = adaptBudget(DEFAULT_BUDGET, { highRisk: ['migration'], lowRisk: ['docs'] });
    expect(b.maxAgentInvocations).toBeGreaterThan(DEFAULT_BUDGET.maxAgentInvocations);
  });
});

describe('classifyChangeRisk', () => {
  it('auth/migration/依赖升级/public-api 路径 → 高风险因子', () => {
    const r = classifyChangeRisk([
      { path: 'src/auth/login.ts' },
      { path: 'migrations/0016_add_col.sql' },
      { path: 'package.json' },
      { path: 'api/v1/public/orders.ts' },
    ]);
    expect(r.highRisk).toEqual(expect.arrayContaining(['auth-security', 'migration', 'dependency-major-upgrade', 'public-api']));
    expect(r.lowRisk).toEqual([]);
  });
  it('文档/生成代码 → 低风险因子', () => {
    const r = classifyChangeRisk([{ path: 'docs/guide.md' }, { path: 'dist/bundle.min.js' }, { path: 'api.pb.go' }]);
    expect(r.lowRisk).toEqual(expect.arrayContaining(['docs', 'generated-code']));
    expect(r.highRisk).toEqual([]);
  });
  it('变更文件数达阈值 → large-refactor', () => {
    const files = Array.from({ length: 25 }, (_, i) => ({ path: `src/mod${i}.ts` }));
    expect(classifyChangeRisk(files).highRisk).toContain('large-refactor');
  });
  it('普通源码 → 无因子(factor=1)', () => {
    const r = classifyChangeRisk([{ path: 'src/util.ts' }]);
    expect(r.highRisk).toEqual([]);
    expect(r.lowRisk).toEqual([]);
    expect(computeRiskFactor(r)).toBe(1);
  });
  it('factor 与 adaptBudget 一致(高风险优先)', () => {
    const r = classifyChangeRisk([{ path: 'src/auth/token.ts' }, { path: 'README.md' }]);
    expect(computeRiskFactor(r)).toBeGreaterThan(1); // high risk wins over low risk
  });
});

describe('budgetExceeded', () => {
  const used: BudgetConsumption = {
    wallTimeSeconds: 100,
    agentInvocations: 5,
    modelInputTokens: 1000,
    modelOutputTokens: 1000,
    toolCpuSeconds: 10,
    sandboxCommands: 5,
    artifactsBytes: 1000,
    scopes: 2,
  };
  it('未超 → 不违反', () => {
    expect(budgetExceeded(DEFAULT_BUDGET, used).exceeded).toBe(false);
  });
  it('超限项被列出', () => {
    const r = budgetExceeded(DEFAULT_BUDGET, { ...used, sandboxCommands: 9999, scopes: 9999 });
    expect(r.exceeded).toBe(true);
    expect(r.violations.some((v) => v.startsWith('sandboxCommands'))).toBe(true);
    expect(r.violations.some((v) => v.startsWith('scopes'))).toBe(true);
  });
});

describe('computeCostPerReview', () => {
  it('汇总模型/工具/sandbox 成本', () => {
    const cost = computeCostPerReview(
      { wallTimeSeconds: 0, agentInvocations: 0, modelInputTokens: 1_000_000, modelOutputTokens: 500_000, toolCpuSeconds: 100, sandboxCommands: 10, artifactsBytes: 0, scopes: 0 },
      { inputPerMillionTokens: 3, outputPerMillionTokens: 15, toolCpuSecond: 0.01, sandboxCommand: 0.02 },
    );
    expect(cost.modelInput).toBeCloseTo(3);
    expect(cost.modelOutput).toBeCloseTo(7.5);
    expect(cost.toolCpu).toBeCloseTo(1);
    expect(cost.sandbox).toBeCloseTo(0.2);
    expect(cost.total).toBeCloseTo(11.7);
  });
});
