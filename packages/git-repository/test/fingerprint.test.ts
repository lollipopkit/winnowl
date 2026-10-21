import { describe, expect, it } from 'vitest';
import { materialFingerprint, type MaterialFingerprintInput } from '../src/index.js';

const base: MaterialFingerprintInput = {
  repositoryId: 'r',
  mergeBaseSha: 'm',
  baseSha: 'b',
  headSha: 'h',
  configDigest: 'c',
  promptBundleDigest: 'p',
  modelPolicyDigest: 'mp',
  toolRegistryDigest: 't',
};

describe('materialFingerprint', () => {
  it('确定性 + BLAKE3 32 字节', () => {
    expect(materialFingerprint(base)).toBe(materialFingerprint(base));
    expect(materialFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('任一输入变化都改变指纹', () => {
    for (const key of Object.keys(base) as (keyof MaterialFingerprintInput)[]) {
      const changed = { ...base, [key]: base[key] + 'X' };
      expect(materialFingerprint(changed)).not.toBe(materialFingerprint(base));
    }
  });
});
