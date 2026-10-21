import { describe, expect, it } from 'vitest';
import { claimSimilarity, mergeSameDefect, nearDuplicateIds } from '../src/index.js';

describe('近似重复折叠(§25.1 输出质量修复)', () => {
  // Two same-root-cause ci.yml claims with different wording.
  const A = 'The lint job is not a validation step: it only prints hard-coded diagnostics and exits 1, so every push and pull-request run fails regardless of the source and it never analyzes the modules.';
  const B = 'The CI workflow is not a real lint/validation step: it unconditionally echoes two hard-coded errors and exits 1, so every push and pull request fails regardless of repository state.';
  const MUL = 'mul does not implement multiplication: mul(3,4) returns 7 instead of 12.';
  const DIV = 'divide passes zero denominators directly to JavaScript arithmetic, yielding Infinity for divide(1,0).';

  it('同根因(假 CI)不同措辞 → 高相似度(会被去重)', () => {
    expect(claimSimilarity(A, B)).toBeGreaterThanOrEqual(0.62);
  });

  it('不同 finding(mul vs divide)→ 低相似度(不误并)', () => {
    expect(claimSimilarity(MUL, DIV)).toBeLessThan(0.62);
  });

  it('nearDuplicateIds:同文件近似重复保留 rank 高者,抑制低者', () => {
    const dup = nearDuplicateIds([
      { id: 'a', path: 'ci.yml', claim: A, rank: 5 },
      { id: 'b', path: 'ci.yml', claim: B, rank: 3 }, // Lower rank -> suppressed.
      { id: 'c', path: 'math.js', claim: MUL, rank: 4 },
      { id: 'd', path: 'math.js', claim: DIV, rank: 4 },
    ]);
    expect(dup).toEqual(new Set(['b'])); // Only the lower-rank ci.yml item is suppressed; mul/divide are kept.
  });

  it('同文件同锚行 → 去重(即便措辞差异大;解决 subtract L3×2 漏网)', () => {
    // Two differently worded subtract claims (similarity may be < 0.62), both anchored at L3.
    const s1 = 'subtract reverses the documented operand order: it computes b - a even though the contract says subtract b from a; subtract(5,2) returns -3.';
    const s2 = 'subtract violates the arithmetic API operand-order contract used by neighboring add/mul/divide exports: returns b-a rather than a-b for any consumer.';
    const dup = nearDuplicateIds([
      { id: 's1', path: 'subtract.js', claim: s1, rank: 6, line: 3 },
      { id: 's2', path: 'subtract.js', claim: s2, rank: 4, line: 3 }, // Same line -> deduped (lower rank).
      { id: 'x', path: 'subtract.js', claim: 'unrelated finding on another line', rank: 5, line: 9 },
    ]);
    expect(dup).toEqual(new Set(['s2']));
  });

  it('同文件不同锚行 + 低相似 → 不去重', () => {
    const dup = nearDuplicateIds([
      { id: 'a', path: 'f.ts', claim: MUL, rank: 5, line: 6 },
      { id: 'b', path: 'f.ts', claim: DIV, rank: 4, line: 14 },
    ]);
    expect(dup.size).toBe(0);
  });

  // Chinese claims: tokenizing only on /[^a-z0-9_.]+/ would treat all CJK as separators, so similarity
  // would always be 0 and `isDismissed` / in-round folding would never fire for Chinese tenants.
  const ZH_A = '该 lint 任务并不是真正的校验步骤:它只打印写死的诊断信息然后以 1 退出,因此每次推送和合并请求都会失败,从不真正分析模块。';
  const ZH_B = 'CI 工作流不是真正的 lint 校验步骤:它无条件打印两条写死的错误信息然后以 1 退出,于是每次推送和合并请求都失败,与仓库状态无关。';
  const ZH_C = '除法把零分母直接交给 JavaScript 算术运算,divide(1,0) 得到 Infinity 而不是报错。';

  it('中文同根因不同措辞 → 高相似度(会被去重)', () => {
    expect(claimSimilarity(ZH_A, ZH_B)).toBeGreaterThanOrEqual(0.62);
  });

  it('中文不同 finding → 低相似度(不误并)', () => {
    expect(claimSimilarity(ZH_A, ZH_C)).toBeLessThan(0.62);
    expect(claimSimilarity(ZH_C, '面板保存配置时把全部默认值写成显式覆盖,之后 schema 默认变更不再生效。')).toBeLessThan(0.62);
  });

  it('中文 claim 也能被 nearDuplicateIds 折叠', () => {
    const dup = nearDuplicateIds([
      { id: 'a', path: 'ci.yml', claim: ZH_A, rank: 5 },
      { id: 'b', path: 'ci.yml', claim: ZH_B, rank: 3 },
      { id: 'c', path: 'ci.yml', claim: ZH_C, rank: 4 },
    ]);
    expect(dup).toEqual(new Set(['b']));
  });

  it('跨文件不去重(即使相似)', () => {
    const dup = nearDuplicateIds([
      { id: 'a', path: 'x.ts', claim: A, rank: 5 },
      { id: 'b', path: 'y.ts', claim: A, rank: 3 },
    ]);
    expect(dup.size).toBe(0);
  });
});

// Multiple rows for the same defect in the gate list: persistence has no merge, so presentation must collapse them.
describe('mergeSameDefect(展示前合并同一缺陷)', () => {
  const A = 'The lint job is not a validation step: it only prints hard-coded diagnostics and exits 1, so every push and pull-request run fails regardless of the source and it never analyzes the modules.';
  const B = 'The CI workflow is not a real lint/validation step: it unconditionally echoes two hard-coded errors and exits 1, so every push and pull request fails regardless of repository state.';
  const MUL = 'mul does not implement multiplication: mul(3,4) returns 7 instead of 12.';

  it('同文件 + 措辞不同的同一缺陷 → 并成一行,保留输入顺序的第一条', () => {
    const r = mergeSameDefect([
      { path: 'ci.yml', claim: A },
      { path: 'ci.yml', claim: B },
    ]);
    expect(r.kept.map((k) => k.claim)).toEqual([A]);
    expect(r.merged).toBe(1);
  });

  it('不同缺陷不并(同文件也不并)', () => {
    const r = mergeSameDefect([
      { path: 'ci.yml', claim: A },
      { path: 'ci.yml', claim: MUL },
    ]);
    expect(r.kept).toHaveLength(2);
    expect(r.merged).toBe(0);
  });

  it('跨文件不并 —— 同一句话落在两个文件上是两件事', () => {
    const r = mergeSameDefect([
      { path: 'a.ts', claim: A },
      { path: 'b.ts', claim: A },
    ]);
    expect(r.kept).toHaveLength(2);
  });

  it('path 都缺省时按 claim 判(门禁清单里锚不住的历史项没有 path)', () => {
    const r = mergeSameDefect([{ claim: A }, { claim: B }, { claim: MUL }]);
    expect(r.kept.map((k) => k.claim)).toEqual([A, MUL]);
    expect(r.merged).toBe(1);
  });
});
