import { describe, expect, it } from 'vitest';
import { mapConcurrent } from '../src/index.js';

describe('mapConcurrent(§18/§21 有界并发 verify)', () => {
  it('保持结果顺序,且并发度受限', async () => {
    let active = 0;
    let maxActive = 0;
    const out = await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return x * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]); // Output order matches input.
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1); // Actually ran in parallel.
  });

  it('并发比顺序快(7 项 × 15ms,limit 3 应 < 顺序 105ms)', async () => {
    const t0 = Date.now();
    await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
    expect(Date.now() - t0).toBeLessThan(90);
  });

  it('任一 fn 抛错 → 整体 reject(与顺序循环语义一致)', async () => {
    await expect(
      mapConcurrent([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }),
    ).rejects.toThrow('boom');
  });

  it('limit=1 退化为顺序;空输入返回空', async () => {
    expect(await mapConcurrent([1, 2, 3], 1, async (x) => x + 1)).toEqual([2, 3, 4]);
    expect(await mapConcurrent([], 4, async (x) => x)).toEqual([]);
  });
});
