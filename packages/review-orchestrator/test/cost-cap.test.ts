import { describe, expect, it } from 'vitest';
import { overCostCapUsd } from '../src/index.js';

describe('单次 review 成本闸判定(§成本闸)', () => {
  it('未设/0/负数 = 不限(默认行为不变)', () => {
    expect(overCostCapUsd(999, undefined)).toBe(false);
    expect(overCostCapUsd(999, 0)).toBe(false);
    expect(overCostCapUsd(999, -1)).toBe(false);
  });

  it('闭区间:达到即停,不允许"刚好等于再来一次"', () => {
    expect(overCostCapUsd(0.99, 1)).toBe(false);
    expect(overCostCapUsd(1, 1)).toBe(true);
    expect(overCostCapUsd(1.01, 1)).toBe(true);
  });

  it('零成本时不误触发(usage 缺省的模型不该被闸挡住)', () => {
    expect(overCostCapUsd(0, 5)).toBe(false);
  });
});
