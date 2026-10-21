import { describe, expect, it } from 'vitest';
import { semanticFingerprint, weakFingerprint } from '../src/fingerprint.js';

describe('fingerprints', () => {
  // Otherwise the second occurrence is swallowed by the unique key.
  it('the same claim on the same code in two files is two findings', () => {
    const base = { repositoryId: 'r', category: 'correctness', claim: 'crash on empty', codeWindow: 'xs[0].toFixed(1)' };
    expect(semanticFingerprint({ ...base, path: 'src/a.js' })).not.toBe(semanticFingerprint({ ...base, path: 'src/b.js' }));
    const weak = { repositoryId: 'r', category: 'correctness', codeWindow: 'xs[0].toFixed(1)' };
    expect(weakFingerprint({ ...weak, path: 'src/a.js' })).not.toBe(weakFingerprint({ ...weak, path: 'src/b.js' }));
    // Wording and number drift still don't matter.
    expect(semanticFingerprint({ ...base, claim: 'Crash on empty 2', path: 'src/a.js' })).toBe(
      semanticFingerprint({ ...base, claim: 'crash on empty 7', path: 'src/a.js' }),
    );
  });
});
