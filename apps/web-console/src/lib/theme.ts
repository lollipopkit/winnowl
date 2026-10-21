/** Maps status/severity/lifecycle strings to Badge tones. */
export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

const TONE_BY_VALUE: Record<string, BadgeTone> = {
  approved: 'ok', executed: 'ok', confirmed: 'ok', merged: 'ok', success: 'ok',
  active: 'ok', complete: 'ok', completed: 'ok', published: 'ok', done: 'ok',
  open: 'ok', ok: 'ok', ready: 'ok',
  proposed: 'warn', pending: 'warn', running: 'warn', queued: 'warn', draft: 'warn',
  in_progress: 'warn', review: 'warn', medium: 'warn', reviewed: 'warn',
  rejected: 'danger', revoked: 'danger', failed: 'danger', error: 'danger',
  blocked: 'danger', suppressed: 'danger', critical: 'danger', high: 'danger',
  low: 'neutral', info: 'neutral', closed: 'neutral', neutral: 'neutral',
};

export function toneFor(value: string | null | undefined): BadgeTone {
  if (!value) return 'neutral';
  return TONE_BY_VALUE[value.trim().toLowerCase()] ?? 'neutral';
}
