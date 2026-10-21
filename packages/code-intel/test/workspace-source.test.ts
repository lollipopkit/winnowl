import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '@reviewbot/canonical-diff';
import { WorkspaceSourceProvider, changedFilesFromDiff } from '../src/index.js';

describe('WorkspaceSourceProvider', () => {
  let dir: string;
  let source: WorkspaceSourceProvider;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvb-src-'));
    await mkdir(join(dir, 'pkg'), { recursive: true });
    await writeFile(join(dir, 'app.py'), 'def add(a, b):\n    return a + b\n');
    await writeFile(join(dir, 'pkg', 'util.py'), 'SECRET_TOKEN = "x"\n');
    source = new WorkspaceSourceProvider(dir, [{ path: 'app.py', status: 'modified' }]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([true, false])('searchSymbol 整词且区分大小写(ripgrep=%s)', async (useRipgrep) => {
    await writeFile(join(dir, 'sym.ts'), 'const add = 1;\nconst addAll = 2;\nconst ADD = 3;\nx.add(1);\n');
    const src = new WorkspaceSourceProvider(dir, [], 50, useRipgrep);
    const hits = (await src.searchSymbol('add')).filter((h) => h.path === 'sym.ts').map((h) => h.line);
    expect(hits).toEqual([1, 4]);
    expect(await src.searchSymbol('not an identifier')).toEqual([]);
  });

  it('readFile / 变更清单', async () => {
    expect(await source.readFile('app.py')).toContain('def add');
    expect(await source.readFile('missing.py')).toBeNull();
    expect(await source.listChangedFiles()).toEqual([{ path: 'app.py', status: 'modified' }]);
  });

  it('路径穿越被阻止', async () => {
    expect(await source.readFile('../../../etc/hostname')).toBeNull();
  });

  it('does not follow workspace symlinks outside the root', async () => {
    const outside = join(tmpdir(), `rvb-src-secret-${Date.now()}`);
    await writeFile(outside, 'not workspace data\nconst leakedSymbol = 1;\n');
    await symlink(outside, join(dir, 'escaped-link'));
    try {
      expect(await source.readFile('escaped-link')).toBeNull();
      // Outside the root in the sandbox is the executor spec, which holds model keys.
      for (const useRipgrep of [true, false]) {
        const src = new WorkspaceSourceProvider(dir, [], 50, useRipgrep);
        expect(await src.searchCode('not workspace data')).toEqual([]);
        expect(await src.searchSymbol('leakedSymbol')).toEqual([]);
      }
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('searchCode(默认路径:rg 可用走 rg,否则回退遍历——语义一致)', async () => {
    const hits = await source.searchCode('SECRET_TOKEN');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe(join('pkg', 'util.py'));
    expect(hits[0]!.line).toBe(1);
  });

  it('searchCode 纯 JS 遍历兜底(useRipgrep=false)与默认路径同结果', async () => {
    const walkOnly = new WorkspaceSourceProvider(dir, [], 50, false);
    const hits = await walkOnly.searchCode('secret_token'); // case-insensitive
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe(join('pkg', 'util.py'));
    expect(await source.searchCode('secret_token')).toEqual(hits);
  });

  it('searchCode 无匹配 → 空数组(两路径)', async () => {
    expect(await source.searchCode('NO_SUCH_NEEDLE_XYZ')).toEqual([]);
    expect(
      await new WorkspaceSourceProvider(dir, [], 50, false).searchCode('NO_SUCH_NEEDLE_XYZ'),
    ).toEqual([]);
  });

  it('changedFilesFromDiff 从 Canonical Diff 提取', () => {
    const diff = parseUnifiedDiff(
      'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(changedFilesFromDiff(diff)).toEqual([{ path: 'x.ts', status: 'modified' }]);
  });

  it('changedFilesFromDiff marks a rename without content changes as a pure move', () => {
    const diff = parseUnifiedDiff(
      'diff --git a/old/f.txt b/new/f.txt\nsimilarity index 100%\nrename from old/f.txt\nrename to new/f.txt\n' +
        'diff --git a/a.ts b/b.ts\nsimilarity index 80%\nrename from a.ts\nrename to b.ts\n--- a/a.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(changedFilesFromDiff(diff)).toEqual([
      { path: 'new/f.txt', status: 'renamed', pureMove: true },
      { path: 'b.ts', status: 'renamed' },
    ]);
  });
});
