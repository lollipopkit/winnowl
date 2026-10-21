import { describe, expect, it } from 'vitest';
import { pickReviewRound } from '../src/review-round.js';

const f = (path: string, status = 'modified') => ({ path, status });

describe('pickReviewRound', () => {
  it('takes the first files by path, keeps deletions with the round, and defers the rest', () => {
    const files = [f('b/2.ts'), f('a/1.ts'), f('gone.ts', 'deleted'), f('a/3.ts'), f('c/4.ts')];
    const { round, deferred } = pickReviewRound(files, 2);
    expect(round.map((x) => x.path)).toEqual(['a/1.ts', 'gone.ts', 'a/3.ts']);
    expect(deferred).toEqual(['b/2.ts', 'c/4.ts']);
  });

  it('pure moves take no slot and are never deferred', () => {
    const files = [f('a.ts'), { path: 'b/moved.txt', status: 'renamed', pureMove: true }, f('c.ts')];
    const { round, deferred } = pickReviewRound(files, 1);
    expect(round.map((x) => x.path)).toEqual(['a.ts', 'b/moved.txt']);
    expect(deferred).toEqual(['c.ts']);
  });

  it('reviews everything when under the limit or the limit is 0', () => {
    const files = [f('a.ts'), f('b.ts')];
    expect(pickReviewRound(files, 2).deferred).toEqual([]);
    expect(pickReviewRound(files, 0).round).toHaveLength(2);
  });
});
