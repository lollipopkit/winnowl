import { describe, expect, it } from 'vitest';
import { submoduleSuffix } from '../src/index.js';

const from = 'a'.repeat(40);
const to = 'b'.repeat(40);

describe('submoduleSuffix', () => {
  it('adds nothing when the change moves no submodule', () => {
    expect(submoduleSuffix(undefined)).toBe('');
    expect(submoduleSuffix([])).toBe('');
  });

  it('keeps the submodule out of review but asks for this repository side against what changed', () => {
    const s = submoduleSuffix([
      {
        path: 'packages/lib',
        fromSha: from,
        toSha: to,
        checkedOut: true,
        changes: { files: [{ status: 'M', path: 'lib/l10n.dart' }], total: 1 },
      },
    ]);
    expect(s).toContain('`packages/lib`: aaaaaaaaaaaa → bbbbbbbbbbbb');
    expect(s).toContain('M packages/lib/lib/l10n.dart');
    expect(s).toContain('do not review its own code');
    expect(s).toContain("this repository's side");
  });

  it('says what is missing when the files or the listing are not available', () => {
    expect(submoduleSuffix([{ path: 'p', fromSha: from, toSha: to, checkedOut: false }])).toContain('not in the checkout');
    expect(submoduleSuffix([{ path: 'p', fromSha: from, toSha: to, checkedOut: true }])).toContain('list of what changed is not available');
    expect(submoduleSuffix([{ path: 'p', toSha: to, checkedOut: true }])).toContain('added at bbbbbbbbbbbb');
  });

  it('keeps the file list bounded', () => {
    const files = Array.from({ length: 70 }, (_, i) => ({ status: 'M', path: `f${i}.ts` }));
    const s = submoduleSuffix([{ path: 'p', fromSha: from, toSha: to, checkedOut: true, changes: { files, total: 300 } }]);
    expect(s).toContain('M p/f59.ts');
    expect(s).not.toContain('M p/f60.ts');
    expect(s).toContain('and 240 more');
  });
});
