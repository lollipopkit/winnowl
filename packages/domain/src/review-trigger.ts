/**
 * Click-to-trigger checkboxes in bot comments, recognised by a hidden marker; only an
 * unchecked-to-checked edit triggers. The marker follows the box because GitHub renders a
 * checkbox only when `- [ ]` starts the line.
 */
export type TriggerKind = 'review' | 'fix';

export const REVIEW_TRIGGER_MARKER = triggerMarker('review');

function triggerMarker(kind: TriggerKind): string {
  return `<!-- winnowl:trigger=${kind} -->`;
}

export function triggerCheckbox(kind: TriggerKind, label: string): string {
  return `- [ ] ${triggerMarker(kind)} ${label}`;
}

export function reviewTriggerCheckbox(label: string): string {
  return triggerCheckbox('review', label);
}

const box = (kind: TriggerKind, checked: boolean) =>
  new RegExp(`^\\s*[-*] \\[${checked ? '[xX]' : ' '}\\] ${escape(triggerMarker(kind))}`, 'm');

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Unchecked before, checked after. Without a previous body (GitLab note updates), checked-now
 * suffices: we only ever write unchecked boxes and rewrite them after triggering.
 */
export function triggerTicked(kind: TriggerKind, before: string | undefined, after: string): boolean {
  if (!box(kind, true).test(after)) return false;
  return before === undefined || box(kind, false).test(before);
}

export function reviewTriggerTicked(before: string | undefined, after: string): boolean {
  return triggerTicked('review', before, after);
}
