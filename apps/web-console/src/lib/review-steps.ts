import type { ReviewCountKind, ReviewProgressItem } from './api';

type Steps = { stepIndex: number | null; stepCount: number; countKind: ReviewCountKind; done: number | null; total: number | null };
import type { TranslationFunctions } from './i18n/i18n-types';

/** Labels by step index; the backend exposes only index and count, never stage names. */
export function reviewSteps(LL: TranslationFunctions): string[] {
  return [
    LL.progress.sFetching(),
    LL.progress.sReading(),
    LL.progress.sExamining(),
    LL.progress.sConnecting(),
    LL.progress.sChecking(),
    LL.progress.sPosting(),
  ];
}

/** A step bar with mismatched labels would mislead; callers hide it instead. */
export function stepsUsable(it: Steps, labels: number): boolean {
  return it.stepIndex !== null && it.stepCount === labels && it.stepIndex >= 0 && it.stepIndex < labels;
}

export function isRunning(it: ReviewProgressItem): boolean {
  return !it.finishedAt && !it.outcome;
}

export function elapsed(from: string, to: string | null, now: number): string {
  const s = Math.floor(Math.max(0, (to ? Date.parse(to) : now) - Date.parse(from)) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

export function stepCount(LL: TranslationFunctions, it: Steps): string | null {
  if (it.done === null || it.total === null) return null;
  if (it.countKind === 'findings') return LL.progress.verified({ done: it.done, total: it.total });
  if (it.countKind === 'areas') return LL.progress.of({ done: it.done, total: it.total });
  return null;
}
