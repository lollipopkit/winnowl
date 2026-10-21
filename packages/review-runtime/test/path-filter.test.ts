import { describe, expect, it } from 'vitest';
import type { SourceProvider } from '@reviewbot/agent-pi';
import { applyPathFilter, partitionIgnoredPaths, submoduleBumpsOf } from '../src/path-filter.js';

const DEFAULT_GLOBS = ['**/vendor/**', '**/dist/**', '**/*.min.js', '**/*.lock', '**/package-lock.json', '**/*.png'];

describe('partitionIgnoredPaths(§reviews.ignored_paths,类 CodeRabbit path filters)', () => {
  it('默认集:lock/图片顶层与嵌套均命中,源码保留', () => {
    const { kept, ignored } = partitionIgnoredPaths(
      [
        { path: 'pubspec.lock', status: 'modified' },
        { path: 'macos/Podfile.lock', status: 'modified' },
        { path: 'monitor/frontend/package-lock.json', status: 'modified' },
        { path: 'doc/imgs/ios-push.png', status: 'added' },
        { path: 'src/a.ts', status: 'modified' },
      ],
      DEFAULT_GLOBS,
    );
    expect(kept.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(ignored).toEqual([
      { path: 'pubspec.lock', glob: '**/*.lock' },
      { path: 'macos/Podfile.lock', glob: '**/*.lock' },
      // `**/*.lock` does not match .json; the first matching glob is recorded
      { path: 'monitor/frontend/package-lock.json', glob: '**/package-lock.json' },
      { path: 'doc/imgs/ios-push.png', glob: '**/*.png' },
    ]);
  });
  it('空 globs → 全保留', () => {
    const { kept, ignored } = partitionIgnoredPaths([{ path: 'pubspec.lock', status: 'modified' }], []);
    expect(kept).toHaveLength(1);
    expect(ignored).toHaveLength(0);
  });
});

function fauxSource(paths: string[]): SourceProvider {
  return {
    listChangedFiles: async () => paths.map((path) => ({ path, status: 'modified' })),
    readFile: async (path) => `content of ${path}`,
    searchCode: async () => [],
  };
}

describe('applyPathFilter(收口包装)', () => {
  it('listChangedFiles 只见保留文件;isChangedLine 对被滤文件恒 false;readFile 不拦', async () => {
    const wsView = {
      source: fauxSource(['pubspec.lock', 'src/a.ts']),
      isChangedLine: () => true,
    };
    const { wsView: filtered, changedFiles, ignoredFiles } = await applyPathFilter(wsView, DEFAULT_GLOBS);
    expect(changedFiles.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(ignoredFiles).toEqual([{ path: 'pubspec.lock', glob: '**/*.lock' }]);
    expect((await filtered.source.listChangedFiles()).map((f) => f.path)).toEqual(['src/a.ts']);
    expect(filtered.isChangedLine('pubspec.lock', 1)).toBe(false);
    expect(filtered.isChangedLine('src/a.ts', 1)).toBe(true);
    expect(await filtered.source.readFile('pubspec.lock')).toBe('content of pubspec.lock');
  });
  it('classify 在 glob 之后分出生成文件,删除的文件不送去判定', async () => {
    const wsView = { source: fauxSource(['pubspec.lock', 'lib/a.g.dart', 'lib/a.dart', 'lib/old.dart']), isChangedLine: () => true };
    (wsView.source as { listChangedFiles: SourceProvider['listChangedFiles'] }).listChangedFiles = async () => [
      { path: 'pubspec.lock', status: 'modified' },
      { path: 'lib/a.g.dart', status: 'added' },
      { path: 'lib/a.dart', status: 'added' },
      { path: 'lib/old.dart', status: 'deleted' },
    ];
    const seen: string[][] = [];
    const { changedFiles, ignoredFiles, wsView: filtered } = await applyPathFilter(wsView, DEFAULT_GLOBS, async (paths) => {
      seen.push(paths);
      return new Map([['lib/a.g.dart', 'generated' as const]]);
    });
    expect(seen).toEqual([['lib/a.g.dart', 'lib/a.dart']]);
    expect(changedFiles.map((f) => f.path)).toEqual(['lib/a.dart', 'lib/old.dart']);
    expect(ignoredFiles).toEqual([
      { path: 'pubspec.lock', glob: '**/*.lock' },
      { path: 'lib/a.g.dart', reason: 'generated' },
    ]);
    expect(filtered.isChangedLine('lib/a.g.dart', 1)).toBe(false);
  });
  it('无命中 → 原样返回(零包装)', async () => {
    const wsView = { source: fauxSource(['src/a.ts']), isChangedLine: () => true };
    const { wsView: filtered, ignoredFiles } = await applyPathFilter(wsView, DEFAULT_GLOBS);
    expect(filtered).toBe(wsView);
    expect(ignoredFiles).toHaveLength(0);
  });
});

describe('submoduleBumpsOf', () => {
  const from = 'a'.repeat(40);
  const to = 'b'.repeat(40);

  it('carries what the workspace learned about each skipped submodule pointer', () => {
    const changes = { files: [{ status: 'M', path: 'lib/x.dart' }], total: 1 };
    expect(
      submoduleBumpsOf(
        [
          { path: 'packages/lib', reason: 'submodule' },
          { path: 'packages/private', reason: 'submodule' },
          { path: 'gen/a.dart', reason: 'generated' },
        ],
        [
          { path: 'packages/lib', sha: to, previousSha: from, status: 'checked-out', changes },
          { path: 'packages/private', sha: to, status: 'skipped', reason: 'private or missing' },
          { path: 'packages/untouched', sha: to, status: 'checked-out' },
        ],
      ),
    ).toEqual([
      { path: 'packages/lib', toSha: to, fromSha: from, checkedOut: true, changes },
      { path: 'packages/private', toSha: to, checkedOut: false },
    ]);
  });

  it('leaves out a submodule the repository excluded by glob, and returns nothing when none is left', () => {
    expect(
      submoduleBumpsOf([{ path: 'packages/lib', glob: 'packages/**' }], [{ path: 'packages/lib', sha: to, status: 'checked-out' }]),
    ).toBeUndefined();
    expect(submoduleBumpsOf([], undefined)).toBeUndefined();
  });
});
