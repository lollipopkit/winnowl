import { describe, expect, it } from 'vitest';
import { isReviewStage, isStageStrategy, pickStageModelIndex } from '../src/index.js';

describe('pickStageModelIndex(0067 阶段模型分配)', () => {
  const SEED = 'rev-019fd0';

  it('单模型 / 空列表 → 恒 0(不必为一个模型走算法)', () => {
    for (const s of ['fill-first', 'round-robin', 'random'] as const) {
      expect(pickStageModelIndex(1, s, 7, SEED)).toBe(0);
      expect(pickStageModelIndex(0, s, 7, SEED)).toBe(0);
    }
  });

  it('fill-first:恒用第一个 —— 与 0067 之前的行为一致', () => {
    expect([0, 1, 2, 3].map((i) => pickStageModelIndex(3, 'fill-first', i, SEED))).toEqual([0, 0, 0, 0]);
  });

  it('round-robin:按工作单元轮转,绕回', () => {
    expect([0, 1, 2, 3, 4].map((i) => pickStageModelIndex(3, 'round-robin', i, SEED))).toEqual([0, 1, 2, 0, 1]);
  });

  it('round-robin:负数下标也落在区间内(不产生 -1 这种取不到的下标)', () => {
    expect(pickStageModelIndex(3, 'round-robin', -1, SEED)).toBe(2);
  });

  // `random` must be reproducible: a retried revision lands on the same model.
  it('random:同 seed 同单元恒定;换 seed 才可能变', () => {
    const once = [0, 1, 2, 3, 4, 5].map((i) => pickStageModelIndex(3, 'random', i, SEED));
    const again = [0, 1, 2, 3, 4, 5].map((i) => pickStageModelIndex(3, 'random', i, SEED));
    expect(again).toEqual(once);
    expect(once.every((v) => v >= 0 && v < 3)).toBe(true);
    // A different revision must not yield the identical assignment (seed is used).
    const other = [0, 1, 2, 3, 4, 5].map((i) => pickStageModelIndex(3, 'random', i, 'rev-other'));
    expect(other).not.toEqual(once);
  });

  it('random:散得开 —— 不是把所有单元都塞给同一个模型', () => {
    const hits = new Set(Array.from({ length: 60 }, (_, i) => pickStageModelIndex(3, 'random', i, SEED)));
    expect(hits.size).toBe(3);
  });
});

describe('阶段名 / 算法名校验(写入端据此拒绝,不静默忽略)', () => {
  it('认识的名字', () => {
    expect(isReviewStage('dig')).toBe(true);
    expect(isStageStrategy('round-robin')).toBe(true);
  });

  it('vlm 是阶段 —— 它的消费方(读 PR/issue 图片)已经接上', () => {
    expect(isReviewStage('vlm')).toBe(true);
  });

  it('不认识的一律 false', () => {
    expect(isReviewStage('explain')).toBe(false);
    expect(isStageStrategy('weighted')).toBe(false);
  });
});
