/** Locale bootstrap: stored preference > browser languages > en. */
import { locales } from './i18n/i18n-util';
import { loadLocale } from './i18n/i18n-util.sync';
import { setLocale } from './i18n/i18n-svelte';
import type { Locales } from './i18n/i18n-types';

const KEY = 'winnowl_lang';

/**
 * Endonyms: users pick a language before they can read the current UI.
 * `Record<Locales, …>` so a new locale without a name fails to compile.
 */
export const LOCALE_NAMES: Record<Locales, string> = {
  en: 'English',
  zh: '简体中文',
  'zh-Hant': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  ru: 'Русский',
};

/** Uses `navigator.languages`: a supported language is often not the first preference. */
function fromNavigator(): Locales | null {
  if (typeof navigator === 'undefined') return null;
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const raw of tags) {
    if (!raw) continue;
    const tag = raw.toLowerCase();
    // Check zh first and Traditional before Simplified: `zh-TW` also has base subtag `zh`.
    if (tag.startsWith('zh')) return /hant|-tw|-hk|-mo/.test(tag) ? 'zh-Hant' : 'zh';
    const base = tag.split('-')[0];
    const hit = (locales as readonly string[]).find((l) => l.toLowerCase() === tag || l.toLowerCase() === base);
    if (hit) return hit as Locales;
  }
  return null;
}

export function initialLocale(): Locales {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && (locales as readonly string[]).includes(stored)) return stored as Locales;
  } catch {
    /* no localStorage */
  }
  try {
    return fromNavigator() ?? 'en';
  } catch {
    return 'en';
  }
}

/** Must run before `$LL` is used. */
export function initI18n(): Locales {
  const loc = initialLocale();
  loadLocale(loc);
  setLocale(loc);
  return loc;
}

export function currentLocale(): Locales {
  return initialLocale();
}

export function switchLocale(loc: Locales): void {
  localStorage.setItem(KEY, loc);
  location.reload();
}
