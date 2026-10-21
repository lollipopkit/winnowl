/** Enum value → UI label; internal codes never reach the page, unknown values are shown as-is. */
import en from './i18n/en';
import type { TranslationFunctions } from './i18n/i18n-types';

export type EnumKind = keyof TranslationFunctions['enums'];

const camel = (v: string): string => v.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function enumLabel(LL: TranslationFunctions, kind: EnumKind, value: string | null | undefined): string {
  if (!value) return '';
  const key = camel(value);
  // LL is a proxy that answers every key, so check against the base locale.
  if (!Object.hasOwn(en.enums[kind], key)) return value;
  return (LL.enums[kind] as Record<string, () => string>)[key]!();
}

export const severityLabel = (LL: TranslationFunctions, v: string | null | undefined): string =>
  enumLabel(LL, 'severity', v);
