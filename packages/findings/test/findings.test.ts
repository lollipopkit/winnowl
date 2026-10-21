import { describe, expect, it } from 'vitest';
import {
  applyNoiseBudget,
  clampSelfReportedConfirmation,
  decidePublication,
  rankScore,
  severityRank,
  shouldPublish,
  type NoiseItem,
  type PublicationInput,
  type Severity,
} from '../src/index.js';

function input(overrides: Partial<PublicationInput> = {}): PublicationInput {
  return {
    severity: 'high',
    category: 'correctness',
    confirmation: 'independently-verified',
    changeRelation: 'introduced',
    decision: 'accept',
    actionable: true,
    anchorUnique: true,
    anchorScore: 0.99,
    refuterUpheld: true,
    ...overrides,
  };
}

describe('Publication Matrix', () => {
  it('critical + 达门槛 → inline 且可阻断', () => {
    const d = decidePublication(input({ severity: 'critical' }));
    expect(d).toMatchObject({ status: 'confirmed', kind: 'defect', placement: 'inline', blocking: true });
  });

  it('critical 缺 Refuter → 未确认,不阻断', () => {
    const d = decidePublication(input({ severity: 'critical', refuterUpheld: false }));
    expect(d).toMatchObject({ status: 'uncertain', placement: 'folded', blocking: false });
  });

  it('critical + changeRelation unknown → 不达门槛 → 未确认', () => {
    const d = decidePublication(input({ severity: 'critical', changeRelation: 'unknown' }));
    expect(d.status).toBe('uncertain');
    expect(d.blocking).toBe(false);
  });

  // Not blocking must not mean demoted to unconfirmed: the two decisions diverge in `decidePublication`.
  it('preexisting 的 high → 照常 inline 确认,但不阻断', () => {
    const d = decidePublication(input({ changeRelation: 'preexisting-relevant' }));
    expect(d).toMatchObject({ status: 'confirmed', placement: 'inline', blocking: false });
  });

  it('preexisting 的 critical → 仍达确认门槛(归因成立),只是不阻断', () => {
    const d = decidePublication(input({ severity: 'critical', changeRelation: 'preexisting-unrelated' }));
    expect(d).toMatchObject({ status: 'confirmed', placement: 'inline', blocking: false });
  });

  it('blockPreexisting=true → 老问题恢复阻断(遗留代码库的显式选择)', () => {
    const d = decidePublication(input({ changeRelation: 'preexisting-relevant', blockPreexisting: true }));
    expect(d.blocking).toBe(true);
    // Unknown attribution is insufficient evidence; config cannot relax it.
    expect(decidePublication(input({ changeRelation: 'unknown', blockPreexisting: true })).blocking).toBe(false);
  });

  it('exposed / regressed 是本次变更造成的 → 照旧阻断', () => {
    expect(decidePublication(input({ changeRelation: 'exposed' })).blocking).toBe(true);
    expect(decidePublication(input({ changeRelation: 'regressed' })).blocking).toBe(true);
  });

  it('high + tool-confirmed → inline 且可阻断', () => {
    const d = decidePublication(input({ severity: 'high', confirmation: 'tool-confirmed', refuterUpheld: false }));
    expect(d).toMatchObject({ status: 'confirmed', placement: 'inline', blocking: true });
  });

  it('medium + Anchor 唯一 → inline;默认不阻断,仓库把 medium 列入 block_on_severity 才阻断', () => {
    const d = decidePublication(input({ severity: 'medium' }));
    expect(d).toMatchObject({ status: 'confirmed', kind: 'defect', placement: 'inline', blocking: false });
    expect(decidePublication(input({ severity: 'medium', blockOnSeverity: ['critical', 'high', 'medium'] })).blocking).toBe(true);
  });

  it('阻断要独立背书:refuter 未维持的 medium 仍是结论但不阻断;tool-confirmed 无需 refuter', () => {
    const unchallenged = decidePublication(input({ severity: 'medium', refuterUpheld: false, blockOnSeverity: ['critical', 'high', 'medium'] }));
    expect(unchallenged).toMatchObject({ status: 'confirmed', blocking: false });
    const scanned = decidePublication(input({ severity: 'high', refuterUpheld: false, confirmation: 'tool-confirmed' }));
    expect(scanned.blocking).toBe(true);
  });

  it('low = nitpick(类 CodeRabbit Trivial):归 nit,永不阻断', () => {
    const d = decidePublication(input({ severity: 'low', confirmation: 'tool-confirmed' }));
    expect(d).toMatchObject({ kind: 'nit', blocking: false });
    expect(decidePublication(input({ severity: 'low', confirmation: 'tool-confirmed', blockOnSeverity: ['low'] })).blocking).toBe(false);
  });

  it('medium + Anchor 不唯一 → 降级折叠,不丢弃(并说明是锚点的原因)', () => {
    const d = decidePublication(input({ severity: 'medium', anchorUnique: false }));
    expect(d).toMatchObject({ status: 'confirmed', placement: 'folded', demotion: 'anchor-unreliable' });
  });

  it('low + 锚得住 → inline(不再因严重度低而折叠)', () => {
    const d = decidePublication(input({ severity: 'low', confirmation: 'tool-confirmed' }));
    expect(d).toMatchObject({ status: 'confirmed', placement: 'inline', blocking: false });
    expect(d.demotion).toBeUndefined();
  });

  it('inline 的判定不带降级原因(没被降级)', () => {
    expect(decidePublication(input({ severity: 'medium' })).demotion).toBeUndefined();
  });

  it('style 锚不住 → 仍是 nit,只是折叠', () => {
    const d = decidePublication(input({ category: 'style', severity: 'low', anchorUnique: false }));
    expect(d).toMatchObject({ kind: 'nit', placement: 'folded', demotion: 'anchor-unreliable' });
  });

  it('style 锚得住 → nit 且 inline(低严重度不把它打下来)', () => {
    const d = decidePublication(input({ category: 'style', severity: 'low' }));
    expect(d).toMatchObject({ kind: 'nit', placement: 'inline' });
  });

  // Only tightens inline placement, not the confirmed-vs-low-evidence line.
  it('min_confirmation 高于本条确认等级 → 折叠而非 inline,且结论状态不变', () => {
    const d = decidePublication(input({ severity: 'high', confirmation: 'independently-verified', minConfirmation: 'tool-confirmed' }));
    expect(d).toMatchObject({ status: 'confirmed', placement: 'folded', demotion: 'below-min-confirmation', blocking: true });
  });

  it('min_confirmation 达标 → 照常 inline', () => {
    const d = decidePublication(input({ severity: 'high', confirmation: 'tool-confirmed', minConfirmation: 'independently-verified' }));
    expect(d.placement).toBe('inline');
  });

  // `tool-confirmed` is unreachable with read-only verifier tools, so low uses `independently-verified`.
  it('low + independently-verified → 确认(能给出反例的缺陷不因影响小而变假)', () => {
    const d = decidePublication(input({ severity: 'low', confirmation: 'independently-verified' }));
    expect(d).toMatchObject({ status: 'confirmed', placement: 'inline', blocking: false });
  });

  it('锚不住才折叠 —— 这是仅剩的矩阵折叠原因(名额那道在下游)', () => {
    const d = decidePublication(input({ severity: 'low', anchorUnique: false }));
    expect(d).toMatchObject({ placement: 'folded', demotion: 'anchor-unreliable' });
  });

  it('low + 未达确认门槛 → uncertain(呈现,不阻断)', () => {
    const d = decidePublication(input({ severity: 'low', confirmation: 'code-supported' }));
    expect(d).toMatchObject({ status: 'uncertain', blocking: false });
    expect(shouldPublish(d.status)).toBe(true);
  });

  it('uncertain 高风险 → uncertain 且给出高影响的理由(渲染时另分一区)', () => {
    const d = decidePublication(input({ decision: 'uncertain', severity: 'high' }));
    expect(d.status).toBe('uncertain');
    expect(d.reason).toBe('high-impact uncertain');
  });

  it('uncertain 低风险 → uncertain(不静默,但也不当结论)', () => {
    const d = decidePublication(input({ decision: 'uncertain', severity: 'low' }));
    expect(d).toMatchObject({ status: 'uncertain', blocking: false });
  });

  it('reject → refuted(不发布)', () => {
    const d = decidePublication(input({ decision: 'reject' }));
    expect(d).toMatchObject({ status: 'refuted', suppression: 'low-evidence' });
    expect(shouldPublish(d.status)).toBe(false);
  });

  it('test-gap/maintainability/style 默认不阻断(§21.6)', () => {
    const d = decidePublication(input({ category: 'test-gap', severity: 'high', confirmation: 'tool-confirmed' }));
    expect(shouldPublish(d.status)).toBe(true);
    expect(d.blocking).toBe(false);
  });

  it('不可操作 → refuted(not-actionable)', () => {
    const d = decidePublication(input({ actionable: false }));
    expect(d).toMatchObject({ status: 'refuted', suppression: 'not-actionable' });
  });
});

describe('自报确认等级的上限(§20.1)', () => {
  it('自报 tool-confirmed 压回 independently-verified', () => {
    expect(clampSelfReportedConfirmation('tool-confirmed')).toBe('independently-verified');
  });

  it('上限以下的原样保留', () => {
    expect(clampSelfReportedConfirmation('code-supported')).toBe('code-supported');
    expect(clampSelfReportedConfirmation('independently-verified')).toBe('independently-verified');
  });
});

describe('rankScore(仅排序,§21.5)', () => {
  it('critical 高于 low', () => {
    const hi = rankScore({ severity: 'critical', confirmation: 'tool-confirmed', changeRelation: 'introduced', actionable: true, anchorScore: 1 });
    const lo = rankScore({ severity: 'low', confirmation: 'code-supported', changeRelation: 'preexisting-unrelated', actionable: true, anchorScore: 1 });
    expect(hi).toBeGreaterThan(lo);
  });

  it('严重度严格主导:最强的 low 也压不过最弱的 medium', () => {
    const bestLow = rankScore({ severity: 'low', confirmation: 'tool-confirmed', changeRelation: 'introduced', actionable: true, anchorScore: 1, novelty: 1 });
    const worstMedium = rankScore({ severity: 'medium', confirmation: 'hypothesis', changeRelation: 'preexisting-unrelated', actionable: false, anchorScore: 0, novelty: 0 });
    expect(worstMedium).toBeGreaterThan(bestLow);
  });

  it('同一严重度内:其余信号照旧区分先后', () => {
    const strong = rankScore({ severity: 'medium', confirmation: 'independently-verified', changeRelation: 'introduced', actionable: true, anchorScore: 1 });
    const weak = rankScore({ severity: 'medium', confirmation: 'hypothesis', changeRelation: 'preexisting-unrelated', actionable: true, anchorScore: 1 });
    expect(strong).toBeGreaterThan(weak);
  });

  it('严重度序完整:critical > high > medium > low > info', () => {
    const at = (severity: 'critical' | 'high' | 'medium' | 'low' | 'info'): number =>
      rankScore({ severity, confirmation: 'code-supported', changeRelation: 'introduced', actionable: true, anchorScore: 1 });
    const order = [at('critical'), at('high'), at('medium'), at('low'), at('info')];
    expect(order).toEqual([...order].sort((a, b) => b - a));
  });

  it('severityRank:与 rankScore 同一张分层表,可直接按它降序呈现', () => {
    const severities = ['low', 'critical', 'info', 'high', 'medium'] as const;
    expect([...severities].sort((a, b) => severityRank(b) - severityRank(a))).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    // Quota allocation and display order must agree on severity order.
    const byScore = (s: Severity): number => rankScore({ severity: s, confirmation: 'code-supported', changeRelation: 'introduced', actionable: true, anchorScore: 1 });
    for (const [a, b] of [['critical', 'high'], ['high', 'medium'], ['medium', 'low'], ['low', 'info']] as const) {
      expect(severityRank(a) > severityRank(b)).toBe(byScore(a) > byScore(b));
    }
  });
});

describe('applyNoiseBudget(§21.4)', () => {
  it('超出 inline 预算溢出到折叠区,不丢弃', () => {
    const items: NoiseItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`,
      kind: 'defect' as const,
      file: `file${i}.ts`,
      rank: 10 - i,
    }));
    const result = applyNoiseBudget(items, { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 });
    expect(result).toHaveLength(10); // nothing dropped
    expect(result.filter((r) => !r.overflow)).toHaveLength(8);
    expect(result.filter((r) => r.overflow)).toHaveLength(2);
  });

  it('每文件 inline 上限', () => {
    const items: NoiseItem[] = Array.from({ length: 5 }, (_, i) => ({
      id: `f${i}`,
      kind: 'defect' as const,
      file: 'same.ts',
      rank: 5 - i,
    }));
    const result = applyNoiseBudget(items, { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 });
    expect(result.filter((r) => !r.overflow)).toHaveLength(3);
    expect(result.filter((r) => r.overflow).map((r) => r.overflowReason)).toEqual(['per-file-budget', 'per-file-budget']);
  });

  it('溢出原因区分总名额与单文件上限', () => {
    const items: NoiseItem[] = [
      { id: 'a1', kind: 'defect', file: 'a.ts', rank: 9 },
      { id: 'a2', kind: 'defect', file: 'a.ts', rank: 8 }, // per-file limit 1 -> per-file
      { id: 'b1', kind: 'defect', file: 'b.ts', rank: 7 },
      { id: 'c1', kind: 'defect', file: 'c.ts', rank: 6 }, // total quota 2 full -> inline-budget
    ];
    const result = applyNoiseBudget(items, { maxInlineComments: 2, maxInlinePerFile: 1, maxInlineNits: 0 });
    const byId = new Map(result.map((r) => [r.id, r]));
    expect(byId.get('a2')?.overflowReason).toBe('per-file-budget');
    expect(byId.get('c1')?.overflowReason).toBe('inline-budget');
    expect(byId.get('a1')?.overflowReason).toBeUndefined();
  });

  it('nit 走独立名额:不占 inline 预算,超出的才溢出', () => {
    const items: NoiseItem[] = [
      ...Array.from({ length: 2 }, (_, i) => ({ id: `f${i}`, kind: 'defect' as const, file: `f${i}.ts`, rank: 10 - i })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, kind: 'nit' as const, file: `n${i}.ts`, rank: 5 - i })),
    ];
    const result = applyNoiseBudget(items, { maxInlineComments: 2, maxInlinePerFile: 3, maxInlineNits: 2 });
    expect(result.filter((r) => r.kind === 'defect' && !r.overflow)).toHaveLength(2);
    expect(result.filter((r) => r.kind === 'nit' && !r.overflow)).toHaveLength(2);
    // Excess nits overflow (not dropped), lowest rank first.
    expect(result.filter((r) => r.overflow).map((r) => r.id)).toEqual(['n2', 'n3']);
  });

  it('nit 名额为 0 时全部折叠(conservative 档)', () => {
    const items: NoiseItem[] = [{ id: 'n0', kind: 'nit', file: 'a.ts', rank: 1 }];
    const result = applyNoiseBudget(items, { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 0 });
    expect(result[0]).toMatchObject({ overflow: true, overflowReason: 'inline-budget' });
  });
});
