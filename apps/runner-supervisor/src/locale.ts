import { resolveReviewLanguage } from '@reviewbot/i18n';
import type { TranslationFunctions } from './i18n/i18n-types.js';
import { i18nObject, isLocale } from './i18n/i18n-util.js';
import { loadAllLocales } from './i18n/i18n-util.sync.js';

// Load all locale dictionaries once so i18nObject can be used synchronously.
loadAllLocales();

/**
 * Bot text functions for a language; unknown languages fall back to English.
 * Normalized via `@reviewbot/i18n`, not `toLowerCase()`: `isLocale()` matches directory names exactly,
 * so `zh-hant` would silently fall back to English.
 */
export function botMessages(language?: string): TranslationFunctions {
  const lang = resolveReviewLanguage(language);
  return i18nObject(isLocale(lang) ? lang : 'en');
}
