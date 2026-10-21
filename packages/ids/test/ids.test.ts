import { describe, expect, it } from 'vitest';
import { isUuidV7 } from '@reviewbot/domain';
import { uuidv7 } from '../src/index.js';

describe('uuidv7', () => {
  it('生成合法 UUIDv7', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isUuidV7(uuidv7())).toBe(true);
    }
  });

  it('时间有序:较晚时间戳的 UUID 字典序更大', () => {
    const early = uuidv7(1_000_000_000_000);
    const late = uuidv7(2_000_000_000_000);
    expect(early < late).toBe(true);
  });

  it('唯一', () => {
    const set = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(set.size).toBe(1000);
  });
});
