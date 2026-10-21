export type SlopKind =
  | 'meaningless-comment'
  | 'duplicate-code'
  | 'placeholder-implementation'
  | 'unused-abstraction'
  | 'boilerplate-overgeneration'
  | 'happy-path-only-tests'
  | 'doc-code-mismatch';

export const SLOP_KINDS: readonly SlopKind[] = [
  'meaningless-comment',
  'duplicate-code',
  'placeholder-implementation',
  'unused-abstraction',
  'boilerplate-overgeneration',
  'happy-path-only-tests',
  'doc-code-mismatch',
];

/** By default non-blocking, collapsed, not counted as a confirmed bug, and can be turned off. */
export interface SlopDisposition {
  blocking: false;
  collapsed: true;
  countsAsConfirmedBug: false;
  suppressed: boolean;
}

export function slopDisposition(slopEnabled: boolean): SlopDisposition {
  return { blocking: false, collapsed: true, countsAsConfirmedBug: false, suppressed: !slopEnabled };
}

export function isSlopKind(value: string): value is SlopKind {
  return (SLOP_KINDS as readonly string[]).includes(value);
}
