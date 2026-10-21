import { resolveReviewLanguage } from '@reviewbot/i18n';
import type { TranslationFunctions } from './i18n/i18n-types.js';
import { i18nObject, isLocale } from './i18n/i18n-util.js';
import { loadAllLocales } from './i18n/i18n-util.sync.js';

// Load all dictionaries once so i18nObject can be used synchronously.
loadAllLocales();

/**
 * Not `language.toLowerCase()`: `isLocale()` matches directory names exactly, so `zh-hant` would
 * silently fall back to English. `@reviewbot/i18n` returns the canonical spelling.
 */
function pick(language?: string): Parameters<typeof i18nObject>[0] {
  const lang = resolveReviewLanguage(language);
  return isLocale(lang) ? lang : 'en';
}

/** Case-insensitive; unknown languages fall back to English. */
export function summaryLabels(language?: string): TranslationFunctions['summary'] {
  return i18nObject(pick(language)).summary;
}

/** Case-insensitive; unknown languages fall back to English. */
export function findingLabels(language?: string): TranslationFunctions['finding'] {
  return i18nObject(pick(language)).finding;
}
