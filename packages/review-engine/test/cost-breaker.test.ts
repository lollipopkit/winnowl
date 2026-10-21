import { describe, expect, it } from 'vitest';
import { createCostBreaker } from '../src/index.js';

// Exploration-side cost breaker: the stage wall clock bounds time, this bounds spend.
describe('createCostBreaker(§成本闸,探索侧)', () => {
  it('未设/0/负数 = 不限(默认部署行为不变)', () => {
    for (const cap of [undefined, 0, -1]) {
      const b = createCostBreaker(cap);
      b.spend({ costUsd: 999 });
      expect(b.tripped()).toBe(false);
    }
  });

  it('闭区间:达到即停,不允许"刚好等于再来一次"', () => {
    const b = createCostBreaker(1);
    b.spend({ costUsd: 0.99 });
    expect(b.tripped()).toBe(false);
    b.spend({ costUsd: 0.01 });
    expect(b.tripped()).toBe(true);
  });

  it('缺 usage 的调用计 0,不误触发(faux/不报用量的模型不该被闸挡住)', () => {
    const b = createCostBreaker(1);
    b.spend(undefined);
    b.spend(undefined);
    expect(b.spentUsd()).toBe(0);
    expect(b.tripped()).toBe(false);
  });

  it('累加跨阶段:map 花掉的算进同一个额度', () => {
    const b = createCostBreaker(1);
    b.spend({ costUsd: 0.6 }); // map
    b.spend({ costUsd: 0.5 }); // first scope
    expect(b.spentUsd()).toBeCloseTo(1.1);
    expect(b.tripped()).toBe(true);
  });
});
