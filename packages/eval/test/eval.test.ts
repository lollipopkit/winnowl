import { describe, expect, it } from 'vitest';
import { checkThresholds, computeMetrics, evaluateReleaseGate, type CaseResult, type ReleaseGateSignals } from '../src/index.js';

describe('eval 指标', () => {
  it('全部命中 → precision/recall 1,门槛通过', () => {
    const cases: CaseResult[] = [
      {
        caseId: 'c1',
        expected: [{ category: 'correctness', severity: 'high', path: 'a.ts' }],
        produced: [{ category: 'correctness', severity: 'high', path: 'a.ts' }],
      },
    ];
    const m = computeMetrics(cases);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(checkThresholds(m).pass).toBe(true);
  });

  it('误报 → precision 下降,FP 归入对应严重度', () => {
    const cases: CaseResult[] = [
      {
        caseId: 'c1',
        expected: [{ category: 'correctness', severity: 'high', path: 'a.ts' }],
        produced: [
          { category: 'correctness', severity: 'high', path: 'a.ts' }, // TP
          { category: 'security', severity: 'high', path: 'b.ts' }, // FP
        ],
      },
    ];
    const m = computeMetrics(cases);
    expect(m.truePositives).toBe(1);
    expect(m.falsePositives).toBe(1);
    expect(m.precision).toBe(0.5);
    expect(m.bySeverity.high.falsePositives).toBe(1);
  });

  it('漏报 → recall 下降', () => {
    const cases: CaseResult[] = [
      {
        caseId: 'c1',
        expected: [
          { category: 'correctness', severity: 'high', path: 'a.ts' },
          { category: 'security', severity: 'critical', path: 'b.ts' },
        ],
        produced: [{ category: 'correctness', severity: 'high', path: 'a.ts' }],
      },
    ];
    const m = computeMetrics(cases);
    expect(m.recall).toBe(0.5);
    expect(m.bySeverity.critical.falseNegatives).toBe(1);
  });

  it('high/critical 误报超阈值 → 门槛失败(§45.7:<2%)', () => {
    // 50 high TP + 2 high FP -> FP rate ~3.8% > 2%
    const expected = Array.from({ length: 50 }, (_, i) => ({ category: 'correctness', severity: 'high' as const, path: `a${i}.ts` }));
    const produced = [
      ...expected,
      { category: 'security', severity: 'high' as const, path: 'x1.ts' },
      { category: 'security', severity: 'high' as const, path: 'x2.ts' },
    ];
    const m = computeMetrics([{ caseId: 'c', expected, produced }]);
    const check = checkThresholds(m);
    expect(check.pass).toBe(false);
    expect(check.violations[0]).toContain('high/critical FP rate');
  });
});

describe('evaluateReleaseGate', () => {
  const cleanMetrics = computeMetrics([
    { caseId: 'c', expected: [{ category: 'correctness', severity: 'high', path: 'a.ts' }], produced: [{ category: 'correctness', severity: 'high', path: 'a.ts' }] },
  ]);
  const goodSignals: ReleaseGateSignals = {
    anchorResolutionRate: 0.995,
    duplicatePublications: 0,
    sandboxLeaks: 0,
    providerContractPass: true,
    coverageHonest: true,
    categoryRecall: { security: 0.9, concurrency: 0.85 },
    minCategoryRecall: { security: 0.8, concurrency: 0.8 },
  };

  it('全部达标 → 通过', () => {
    expect(evaluateReleaseGate(cleanMetrics, goodSignals).pass).toBe(true);
  });

  it('anchor < 99% / 重复发布 / sandbox 泄漏 / contract 失败 → 阻断', () => {
    const r = evaluateReleaseGate(cleanMetrics, { ...goodSignals, anchorResolutionRate: 0.95, duplicatePublications: 1, sandboxLeaks: 2, providerContractPass: false });
    expect(r.pass).toBe(false);
    expect(r.violations.some((v) => v.includes('anchor resolution'))).toBe(true);
    expect(r.violations.some((v) => v.includes('duplicate publications'))).toBe(true);
    expect(r.violations.some((v) => v.includes('sandbox leaks'))).toBe(true);
    expect(r.violations.some((v) => v.includes('provider contract'))).toBe(true);
  });

  it('按类别 recall 不被总数掩盖(security 低于阈值 → 阻断)', () => {
    const r = evaluateReleaseGate(cleanMetrics, { ...goodSignals, categoryRecall: { security: 0.5, concurrency: 0.9 } });
    expect(r.pass).toBe(false);
    expect(r.violations.some((v) => v.startsWith('security recall'))).toBe(true);
  });
});
