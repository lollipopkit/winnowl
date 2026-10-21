import { describe, expect, it } from 'vitest';
import { lfsPointerSuffix } from '../src/index.js';

describe('lfsPointerSuffix', () => {
  it('adds nothing when the change has no LFS pointer', () => {
    expect(lfsPointerSuffix(undefined)).toBe('');
    expect(lfsPointerSuffix([])).toBe('');
  });

  it('names the pointers and asks whether their consumers fetch LFS', () => {
    const s = lfsPointerSuffix(['assets/store_themes/serverbox.piggy.fsbt']);
    expect(s).toContain('- assets/store_themes/serverbox.piggy.fsbt');
    expect(s).toContain('lfs: true');
  });

  it('keeps the list bounded on a change with many pointers', () => {
    const s = lfsPointerSuffix(Array.from({ length: 25 }, (_, i) => `img/${i}.png`));
    expect(s).toContain('- img/19.png');
    expect(s).not.toContain('- img/20.png');
    expect(s).toContain('and 5 more');
  });
});
