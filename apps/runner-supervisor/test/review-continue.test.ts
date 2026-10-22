import { describe, expect, it } from 'vitest';
import { shouldContinueReview } from '../src/review-continue.js';

describe('shouldContinueReview', () => {
  const covered = { coveredPaths: ['a.ts'] };

  it('continues while files remain and the round made progress, up to the round limit', () => {
    expect(shouldContinueReview({ ...covered, deferredPaths: ['b.ts'] }, {}, 20)).toBe(true);
    expect(shouldContinueReview({ ...covered, unreachedPaths: ['b.ts'] }, { continueRound: 19 }, 20)).toBe(true);
    expect(shouldContinueReview({ ...covered, unplannedPaths: ['b.ts'] }, { continueRound: 20 }, 20)).toBe(false);
  });

  it('stops when nothing remains or the round covered nothing new', () => {
    expect(shouldContinueReview({ ...covered, deferredPaths: [] }, {}, 20)).toBe(false);
    expect(shouldContinueReview({ coveredPaths: [], unreachedPaths: ['b.ts'] }, {}, 20)).toBe(false);
    expect(shouldContinueReview({ unreachedPaths: ['b.ts'] }, {}, 20)).toBe(false);
  });
});
