import type { ReviewLedger } from '@reviewbot/review-engine';

export interface WalkthroughEntry {
  title: string;
  summary: string;
}

/**
 * One walkthrough entry per section. Split parts and remainder scopes are omitted (they reflect how the
 * review ran, not the change). Fixed `planned` scopes (map skipped) use dig's `complete_section` walkthrough.
 */
export function walkthroughOf(
  ledger: Pick<ReviewLedger, 'scopes' | 'scopeOutcomes'>,
): WalkthroughEntry[] {
  const outcomes = new Map(ledger.scopeOutcomes.map((o) => [o.scopeId, o]));
  return ledger.scopes.flatMap((s) => {
    if ((s.part?.index ?? 1) !== 1) return [];
    if (s.origin === undefined) return [{ title: s.title, summary: s.changeSummary }];
    if (s.origin !== 'planned') return [];
    const written = outcomes.get(s.id)?.walkthrough;
    return written ? [{ title: written.title, summary: written.summary }] : [];
  });
}
