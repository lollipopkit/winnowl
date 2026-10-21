/** Locale-aware date/number formatting via Intl; empty or invalid input falls back gracefully. */
import type { Locales } from './i18n/i18n-types.js';

/** `Record<Locales, …>` so a new locale without a mapping fails to compile instead of silently using en-US. */
const BCP47: Record<Locales, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  'zh-Hant': 'zh-TW',
  ja: 'ja-JP',
  ko: 'ko-KR',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  pt: 'pt-BR',
  ru: 'ru-RU',
};

function bcp47(locale: Locales): string {
  return BCP47[locale] ?? 'en-US';
}

/** Empty input returns ''; invalid input is returned as-is. */
export function formatDateTime(value: string | number | Date | null | undefined, locale: Locales): string {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(bcp47(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function formatDate(value: string | number | Date | null | undefined, locale: Locales): string {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(bcp47(locale), { dateStyle: 'medium' }).format(d);
}

export function formatNumber(n: number, locale: Locales, opts?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(n)) return String(n);
  return new Intl.NumberFormat(bcp47(locale), opts).format(n);
}

/** Compact notation for narrow table columns; callers put the exact value in `title`. */
export function formatCompact(n: number, locale: Locales): string {
  if (!Number.isFinite(n)) return String(n);
  return new Intl.NumberFormat(bcp47(locale), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** Up to 4 decimals for small amounts (e.g. $0.0123). */
export function formatUsd(n: number, locale: Locales): string {
  if (!Number.isFinite(n)) return String(n);
  return new Intl.NumberFormat(bcp47(locale), { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(n);
}

/** Relative time within a week, absolute date beyond; callers put the full timestamp in `title`. */
export function formatEventTime(value: string | number | Date | null | undefined, locale: Locales): string {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const WEEK = 7 * 86_400_000;
  return Math.abs(d.getTime() - Date.now()) < WEEK ? formatRelativeTime(d, locale) : formatDate(d, locale);
}

/** Coarse granularity: minutes, hours, days. */
export function formatRelativeTime(value: string | number | Date | null | undefined, locale: Locales): string {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const diffMs = d.getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat(bcp47(locale), { numeric: 'auto' });
  const abs = Math.abs(diffMs);
  const MIN = 60_000;
  const HR = 3_600_000;
  const DAY = 86_400_000;
  if (abs < HR) return rtf.format(Math.round(diffMs / MIN), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diffMs / HR), 'hour');
  return rtf.format(Math.round(diffMs / DAY), 'day');
}
