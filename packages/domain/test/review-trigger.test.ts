import { describe, expect, it } from 'vitest';
import { reviewTriggerCheckbox, reviewTriggerTicked } from '../src/review-trigger.js';

describe('review trigger checkbox', () => {
  const unchecked = `## Review skipped\n\n${reviewTriggerCheckbox('Review anyway')}\n`;
  const checked = unchecked.replace('- [ ]', '- [x]');

  it('fires only on an unchecked → checked transition of our marked box', () => {
    expect(reviewTriggerTicked(unchecked, checked)).toBe(true);
    expect(reviewTriggerTicked(unchecked, unchecked.replace('- [ ]', '- [X]'))).toBe(true);
    expect(reviewTriggerTicked(checked, checked)).toBe(false);
    expect(reviewTriggerTicked(checked, unchecked)).toBe(false);
    // No previous body (GitLab): only the current state counts.
    expect(reviewTriggerTicked(undefined, checked)).toBe(true);
    expect(reviewTriggerTicked(undefined, unchecked)).toBe(false);
    // Ticking an unrelated checkbox does not count.
    const other = `${unchecked}- [ ] something else\n`;
    expect(reviewTriggerTicked(other, other.replace('- [ ] something', '- [x] something'))).toBe(false);
  });
});
