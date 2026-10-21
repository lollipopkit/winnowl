import { describe, expect, it } from 'vitest';
import { isUuid, isUuidV7 } from '../src/ids.js';

describe('ids', () => {
  it('接受合法 UUIDv7', () => {
    const v7 = '018f9a3c-7b2e-7c3d-8a1b-2c3d4e5f6a7b';
    expect(isUuid(v7)).toBe(true);
    expect(isUuidV7(v7)).toBe(true);
  });

  it('识别非 v7 版本', () => {
    const v4 = '550e8400-e29b-41d4-a716-446655440000';
    expect(isUuid(v4)).toBe(true);
    expect(isUuidV7(v4)).toBe(false);
  });

  it('拒绝非法字符串', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuidV7('018f9a3c7b2e7c3d8a1b2c3d4e5f6a7b')).toBe(false);
  });
});
