import { describe, expect, it } from 'vitest';
import { resolveReviewLanguage } from '../src/index.js';

describe('resolveReviewLanguage', () => {
  it.each(['zh-Hant-TW', 'zh-hant-hk', 'zh-TW', 'zh-HK', 'zh-MO'])(
    'maps Traditional Chinese alias %s to zh-Hant',
    (tag) => {
      expect(resolveReviewLanguage(tag)).toBe('zh-Hant');
    },
  );

  it.each(['zh-Hans-CN', 'zh-CN', 'zh-SG'])('maps Simplified Chinese alias %s to zh', (tag) => {
    expect(resolveReviewLanguage(tag)).toBe('zh');
  });

  it.each([
    ['zh_CN', 'zh'],
    ['pt_BR', 'pt'],
    ['zh_TW', 'zh-Hant'],
    ['en_US', 'en'],
  ])('accepts the underscore separator: %s → %s', (tag, expected) => {
    expect(resolveReviewLanguage(tag)).toBe(expected);
  });
});
