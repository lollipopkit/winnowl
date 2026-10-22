import { describe, expect, it } from 'vitest';
import type { SourceProvider } from '@reviewbot/agent-pi';
import { FOCUS_MAX_LINES, changedRanges, focusSuffix, packFocus, prefetchFocus, removalPartSuffix, splitByFocus } from '../src/focus.js';
import type { ReviewScope } from '../src/types.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

function source(files: Record<string, string>): SourceProvider {
  return {
    listChangedFiles: async () => Object.keys(files).map((path) => ({ path, status: 'modified' })),
    readFile: async (path) => files[path] ?? null,
    searchCode: async () => [],
  };
}

describe('changedRanges / packFocus', () => {
  it('merges nearby changed lines and splits long runs into windows', () => {
    const changed = new Set([1, 2, 3, 10, 40, 41]);
    expect(changedRanges('a.ts', 50, (_p, l) => changed.has(l))).toEqual([
      { path: 'a.ts', startLine: 1, endLine: 10 },
      { path: 'a.ts', startLine: 40, endLine: 41 },
    ]);
    const parts = packFocus([{ path: 'a.ts', startLine: 1, endLine: 600 }], 250);
    expect(parts).toEqual([
      [{ path: 'a.ts', startLine: 1, endLine: 250 }],
      [{ path: 'a.ts', startLine: 251, endLine: 500 }],
      [{ path: 'a.ts', startLine: 501, endLine: 600 }],
    ]);
  });
});

describe('splitByFocus', () => {
  const scope: ReviewScope = {
    id: 's1',
    title: 'Chunking',
    changeSummary: 'c',
    obligations: [{ id: 'o1', kind: 'correctness', description: 'x' }],
    files: ['big.ts', 'small.ts'],
  };
  let n = 0;
  const newId = () => `id${(n += 1)}`;

  it('splits a scope whose changes exceed the limit, keeping obligations and giving each part its lines', async () => {
    const src = source({ 'big.ts': lines(FOCUS_MAX_LINES + 100), 'small.ts': lines(20) });
    const out = await splitByFocus([scope], { source: src, isChangedLine: () => true, newId });
    expect(out.map((s) => [s.title, s.part])).toEqual([
      ['Chunking', { index: 1, total: 2, sectionId: 's1' }],
      ['Chunking', { index: 2, total: 2, sectionId: 's1' }],
    ]);
    expect(out[0]!.id).toBe('s1');
    expect(out[1]!.id).not.toBe('s1');
    expect(out[1]!.obligations[0]!.id).not.toBe('o1');
    expect(out[0]!.focus).toEqual([{ path: 'big.ts', startLine: 1, endLine: FOCUS_MAX_LINES }]);
    expect(out[1]!.focus).toEqual([
      { path: 'big.ts', startLine: FOCUS_MAX_LINES + 1, endLine: FOCUS_MAX_LINES + 100 },
      { path: 'small.ts', startLine: 1, endLine: 20 },
    ]);
    expect(out[1]!.files).toEqual(['big.ts', 'small.ts']);
  });

  it('gives files without head-side changes (deletions) a part of their own instead of dropping them', async () => {
    const withDeleted = { ...scope, files: ['big.ts', 'gone.ts', 'small.ts'] };
    const src = source({ 'big.ts': lines(FOCUS_MAX_LINES + 100), 'small.ts': lines(20) });
    const out = await splitByFocus([withDeleted], {
      source: src,
      isChangedLine: (path) => path !== 'gone.ts',
      newId,
    });
    expect(out.map((s) => s.part)).toEqual([
      { index: 1, total: 3, sectionId: 's1' },
      { index: 2, total: 3, sectionId: 's1' },
      { index: 3, total: 3, sectionId: 's1' },
    ]);
    expect(out[2]!.files).toEqual(['gone.ts']);
    expect(out[2]!.focus).toBeUndefined();
    expect(removalPartSuffix(out[2]!)).toContain('- gone.ts');
    expect(removalPartSuffix(out[0]!)).toBe('');
    expect(removalPartSuffix(withDeleted)).toBe('');
  });

  it('leaves small scopes, scopes without files, and runs without diff info alone', async () => {
    const src = source({ 'big.ts': lines(30), 'small.ts': lines(20) });
    expect(await splitByFocus([scope], { source: src, isChangedLine: () => true, newId })).toEqual([scope]);
    const noFiles = { ...scope, files: undefined };
    expect(await splitByFocus([noFiles], { source: src, isChangedLine: () => true, newId })).toEqual([noFiles]);
    expect(await splitByFocus([scope], { source: src, newId })).toEqual([scope]);
  });
});

describe('focus prompt', () => {
  it('names the lines and prefetches them with numbered context', async () => {
    expect(focusSuffix([{ path: 'a.ts', startLine: 5, endLine: 9 }])).toContain('- a.ts lines 5-9');
    const text = await prefetchFocus(source({ 'a.ts': lines(100) }), [{ path: 'a.ts', startLine: 50, endLine: 52 }], 10_000);
    expect(text).toContain('// a.ts lines 30-72');
    expect(text).toContain('   50  line 50');
    expect(text).not.toContain('line 29\n');
  });
});
