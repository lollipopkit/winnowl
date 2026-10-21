import { resolveReviewLanguage } from '@reviewbot/i18n';
import type { TranslationFunctions } from './i18n/i18n-types.js';
import { i18nObject } from './i18n/i18n-util.js';
import { loadAllLocales } from './i18n/i18n-util.sync.js';

loadAllLocales();

/** Case-insensitive; unknown locales fall back to English. */
export function mailMessages(language?: string): TranslationFunctions {
  const locale = resolveReviewLanguage(language) === 'zh' ? 'zh' : 'en';
  return i18nObject(locale);
}
