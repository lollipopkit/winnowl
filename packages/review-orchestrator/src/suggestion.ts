import type { CommittableSuggestion } from '@reviewbot/verification';

/**
 * Pre-publish validation of committable suggestions. A wrong suggestion lands in code with one click, so any
 * failed check drops the suggestion (the finding still publishes without it).
 */
export interface SuggestionContext {
  /** All head-side lines of the file (0-indexed array; line numbers are 1-based). */
  headLines: string[];
  isChangedLine: (line: number) => boolean;
  /** The suggestion must cover this line. */
  anchorLine: number;
  /** Larger rewrites belong in the full fix flow, not a one-click suggestion. */
  maxLines?: number;
}

export type SuggestionRejection =
  | 'not-accepted'
  | 'out-of-range'
  | 'too-many-lines'
  | 'anchor-not-covered'
  | 'text-mismatch'
  | 'not-changed-lines'
  | 'no-op'
  | 'fence-in-replacement';

export type SuggestionCheck = { ok: true; suggestion: CommittableSuggestion } | { ok: false; reason: SuggestionRejection };

const DEFAULT_MAX_LINES = 10;

/**
 * Notable checks: `originalText` must match head verbatim (catches wrong line numbers); every line must be a
 * changed diff line (GitHub rejects the whole review with 422 otherwise); the replacement must not contain
 * ``` (GitHub only recognises a three-backtick ```suggestion fence, so it cannot be lengthened).
 */
export function validateSuggestion(
  suggestion: CommittableSuggestion | undefined,
  accepted: boolean,
  ctx: SuggestionContext,
): SuggestionCheck {
  if (!suggestion) return { ok: false, reason: 'not-accepted' };
  if (!accepted) return { ok: false, reason: 'not-accepted' };

  const { startLine, endLine, originalText, replacement } = suggestion;
  const maxLines = ctx.maxLines ?? DEFAULT_MAX_LINES;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return { ok: false, reason: 'out-of-range' };
  if (startLine < 1 || endLine < startLine || endLine > ctx.headLines.length) return { ok: false, reason: 'out-of-range' };
  if (endLine - startLine + 1 > maxLines) return { ok: false, reason: 'too-many-lines' };
  if (ctx.anchorLine < startLine || ctx.anchorLine > endLine) return { ok: false, reason: 'anchor-not-covered' };

  // Trailing whitespace is ignored (models often drop it).
  const actual = ctx.headLines.slice(startLine - 1, endLine).join('\n');
  if (normalize(actual) !== normalize(originalText)) return { ok: false, reason: 'text-mismatch' };

  for (let line = startLine; line <= endLine; line += 1) {
    if (!ctx.isChangedLine(line)) return { ok: false, reason: 'not-changed-lines' };
  }
  if (normalize(replacement) === normalize(actual)) return { ok: false, reason: 'no-op' };
  if (replacement.includes('```')) return { ok: false, reason: 'fence-in-replacement' };

  return { ok: true, suggestion };
}

function normalize(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\s+$/, '');
}
