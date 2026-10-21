import { describe, expect, it } from 'vitest';
import type { ReviewScope, ScopeOutcome } from '@reviewbot/review-engine';
import { walkthroughOf } from '../src/walkthrough.js';

const scope = (id: string, over: Partial<ReviewScope> = {}): ReviewScope =>
  ({
    id,
    title: `T ${id}`,
    changeSummary: `S ${id}`,
    obligations: [],
    files: [],
    ...over,
  }) as ReviewScope;
const outcome = (scopeId: string, over: Partial<ScopeOutcome> = {}): ScopeOutcome => ({
  scopeId,
  status: 'complete',
  candidateIds: [],
  exploredEntities: [],
  budgetExhausted: false,
  ...over,
});

describe('walkthroughOf', () => {
  it('lists each mapped section once, and no remainder section', () => {
    const scopes = [
      scope('a', { part: { index: 1, total: 2, sectionId: 'a' } }),
      scope('a2', { part: { index: 2, total: 2, sectionId: 'a' } }),
      scope('r', { origin: 'remainder' }),
    ];
    expect(walkthroughOf({ scopes, scopeOutcomes: [] })).toEqual([
      { title: 'T a', summary: 'S a' },
    ]);
  });

  it('a section planned without a map uses what the reviewer wrote, or nothing', () => {
    const scopes = [scope('p', { origin: 'planned' })];
    expect(walkthroughOf({ scopes, scopeOutcomes: [outcome('p')] })).toEqual([]);
    const written = outcome('p', {
      walkthrough: { title: 'Pick the first positive value', summary: 'Adds alpha().' },
    });
    expect(walkthroughOf({ scopes, scopeOutcomes: [written] })).toEqual([
      { title: 'Pick the first positive value', summary: 'Adds alpha().' },
    ]);
  });
});
