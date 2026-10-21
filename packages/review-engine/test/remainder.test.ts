import { describe, expect, it } from 'vitest';
import { REMAINDER_SCOPE_MAX_FILES, remainderScopes, unassignedFiles } from '../src/remainder.js';
import type { ReviewScope } from '../src/types.js';

const scope = (files?: string[]): ReviewScope => ({
  id: 's',
  title: 't',
  changeSummary: 'c',
  obligations: [],
  ...(files ? { files } : {}),
});

describe('unassignedFiles', () => {
  const changed = [
    { path: 'lib/a.dart', status: 'modified' },
    { path: 'lib/b.dart', status: 'added' },
    { path: 'lib/gone.dart', status: 'deleted' },
    { path: 'README.md', status: 'modified' },
  ];

  it('returns changed files no scope claims, skipping deletions', () => {
    expect(unassignedFiles([scope(['./lib/a.dart'])], changed)).toEqual(['README.md', 'lib/b.dart']);
  });

  it('adds nothing when the scopes list no files at all', () => {
    expect(unassignedFiles([scope()], changed)).toEqual([]);
  });

  it('returns every changed file when the plan has no scopes', () => {
    expect(unassignedFiles([], changed)).toEqual(['README.md', 'lib/a.dart', 'lib/b.dart']);
  });
});

describe('remainderScopes', () => {
  it('groups by directory in chunks and names the common directory', () => {
    let n = 0;
    const paths = [
      ...Array.from({ length: REMAINDER_SCOPE_MAX_FILES + 2 }, (_, i) => `lib/view/p${String(i).padStart(2, '0')}.dart`),
      'test/x_test.dart',
    ];
    const scopes = remainderScopes(paths, () => `id${(n += 1)}`);
    expect(scopes.map((s) => s.files!.length)).toEqual([REMAINDER_SCOPE_MAX_FILES, 3]);
    expect(scopes[0]!.title).toBe('Other changes in lib/view');
    expect(scopes[1]!.title).toBe('Other changes');
    expect(scopes.flatMap((s) => s.files)).toEqual(paths);
    expect(new Set(scopes.flatMap((s) => [s.id, ...s.obligations.map((o) => o.id)])).size).toBe(4);
  });
});
