import { REVIEW_LANGUAGE_NAMES, resolveReviewLanguage } from '@reviewbot/i18n';

/**
 * System prompt suffix for the output language; empty for English or unsupported languages.
 * Uses the language's English name, not the locale code: models misread codes like `zh-Hant` or `pt`.
 * @param kinds the user-facing outputs, e.g. 'finding claims, comments, summaries'.
 */
export function languageInstruction(language: string | undefined, kinds = 'all user-facing output'): string {
  const lang = resolveReviewLanguage(language);
  if (lang === 'en') return '';
  return `\n\nIMPORTANT: Write all user-facing output (${kinds}) in ${REVIEW_LANGUAGE_NAMES[lang]}. Keep code identifiers, file paths and quoted code unchanged.`;
}

/**
 * Output language for review agents, scoped to submitted text fields. `languageInstruction` lowered review
 * recall: models read it as the main goal of the task.
 */
export function submittedTextLanguage(language: string | undefined, fields: string): string {
  const lang = resolveReviewLanguage(language);
  if (lang === 'en') return '';
  const name = REVIEW_LANGUAGE_NAMES[lang];
  return `\n\nOutput language: the text fields you submit (${fields}) are shown to readers of ${name}, so write those fields in ${name}; keep code identifiers, file paths and quoted code unchanged. This affects only the submitted text, not how thoroughly you work: explore, reason and check everything exactly as you would in English.`;
}
