import { describe, expect, it } from 'vitest';
import { resolveProfile, slopDisposition, suppressedByThreshold } from '../src/index.js';

describe('resolveProfile', () => {
  it('预设逐级放宽探索预算与 nit 名额', () => {
    const c = resolveProfile('conservative');
    const t = resolveProfile('thorough');
    expect(t.exploreBudget.maxTurns).toBeGreaterThan(c.exploreBudget.maxTurns);
    expect(t.maxInlineNits).toBeGreaterThan(c.maxInlineNits);
    expect(c.nonBugCategoriesEnabled).toBe(false);
  });

  it('inline 名额不随档位变化', () => {
    const budgets = (['conservative', 'balanced', 'thorough'] as const).map((n) => resolveProfile(n).maxInlineComments);
    expect(new Set(budgets).size).toBe(1);
    expect(budgets[0]).toBe(15);
  });
  it('custom 需提供设置', () => {
    expect(() => resolveProfile('custom')).toThrow();
    const s = resolveProfile('custom', { exploreBudget: { maxTurns: 5, maxToolCalls: 5 }, nonBugCategoriesEnabled: false, maxInlineComments: 2, lowSeverityThreshold: 'high' });
    expect(s.maxInlineComments).toBe(2);
  });
});

describe('suppressedByThreshold — profile 不降低 correctness/security', () => {
  const conservative = resolveProfile('conservative'); // threshold high
  it('非关键类别低于阈值被抑制', () => {
    expect(suppressedByThreshold('style', 'low', conservative)).toBe(true);
    expect(suppressedByThreshold('style', 'critical', conservative)).toBe(false);
  });
  it('correctness/security 恒不被 profile 抑制', () => {
    expect(suppressedByThreshold('correctness', 'low', conservative)).toBe(false);
    expect(suppressedByThreshold('security', 'info', conservative)).toBe(false);
  });
});

describe('slopDisposition', () => {
  it('默认非阻断/折叠/不计 confirmed bug', () => {
    const d = slopDisposition(true);
    expect(d).toMatchObject({ blocking: false, collapsed: true, countsAsConfirmedBug: false, suppressed: false });
  });
  it('仓库关闭 slop → 抑制', () => {
    expect(slopDisposition(false).suppressed).toBe(true);
  });
});
