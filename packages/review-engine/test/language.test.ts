import { describe, expect, it } from 'vitest';
import { languageSuffix } from '../src/engine.js';

describe('languageSuffix — 输出语言注入(§37)', () => {
  it('非英文语言 → 注入呈现语言指令(保留代码标识符不译)', () => {
    const s = languageSuffix('zh');
    // Use the language name, not the locale code: with "zh-Hant" models often still write Simplified.
    expect(s).toContain('Simplified Chinese');
    expect(s).toContain('text fields you submit');
    expect(s).toContain('keep code identifiers');
    // Constrain only submitted text: a global "write in Chinese" instruction reduced recall.
    expect(s).toContain('not how thoroughly you work');
    expect(s).not.toContain('IMPORTANT');
  });

  it('en / 空 → 不注入(默认英文,零开销)', () => {
    expect(languageSuffix('en')).toBe('');
    expect(languageSuffix(undefined)).toBe('');
    expect(languageSuffix('')).toBe('');
  });
});
