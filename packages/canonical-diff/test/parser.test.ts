import { describe, expect, it } from 'vitest';
import { changedLinesByPath, isChangedLine, parseUnifiedDiff, unquotePath } from '../src/index.js';

describe('parseUnifiedDiff', () => {
  it('修改文件:hunk / 行类型 / 行号 / patchLine', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 line1
-line2
+line2-changed
 line3
 line4
`;
    const d = parseUnifiedDiff(diff, { oldSha: 'o', newSha: 'n' });
    expect(d.files).toHaveLength(1);
    const f = d.files[0]!;
    expect(f.status).toBe('modified');
    expect(f.newPath).toBe('src/a.ts');
    expect(f.language).toBe('typescript');
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
    const lines = f.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual(['context', 'deleted', 'added', 'context', 'context']);
    expect(lines.map((l) => l.patchLine)).toEqual([1, 2, 3, 4, 5]);
    expect(lines[1]!.oldLine).toBe(2);
    expect(lines[2]!.newLine).toBe(2);
    expect(lines[2]!.normalized).toBe('line2-changed');
  });

  it('新增文件(--- /dev/null)', () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..abcdef0
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;
    const f = parseUnifiedDiff(diff).files[0]!;
    expect(f.status).toBe('added');
    expect(f.oldPath).toBeUndefined();
    expect(f.newPath).toBe('new.txt');
    expect(f.additions).toBe(2);
  });

  it('删除文件(+++ /dev/null)', () => {
    const diff = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index abcdef0..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2
`;
    const f = parseUnifiedDiff(diff).files[0]!;
    expect(f.status).toBe('deleted');
    expect(f.newPath).toBeUndefined();
    expect(f.oldPath).toBe('gone.txt');
    expect(f.deletions).toBe(2);
  });

  it('重命名', () => {
    const diff = `diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
index 111..222 100644
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,1 +1,1 @@
-old
+new
`;
    const f = parseUnifiedDiff(diff).files[0]!;
    expect(f.status).toBe('renamed');
    expect(f.oldPath).toBe('old/name.ts');
    expect(f.newPath).toBe('new/name.ts');
  });

  it('二进制文件', () => {
    const diff = `diff --git a/img.png b/img.png
index 111..222 100644
Binary files a/img.png and b/img.png differ
`;
    const f = parseUnifiedDiff(diff).files[0]!;
    expect(f.isBinary).toBe(true);
    expect(f.status).toBe('binary');
  });

  it('多 hunk:patchLine 跨 hunk 连续(GitHub position)', () => {
    const diff = `diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -10,2 +10,3 @@
 j
+k
 l
`;
    const f = parseUnifiedDiff(diff).files[0]!;
    expect(f.hunks).toHaveLength(2);
    const k = f.hunks[1]!.lines.find((l) => l.normalized === 'k')!;
    expect(k.patchLine).toBe(6);
    expect(k.newLine).toBe(11);
  });

  it('changedLinesByPath / isChangedLine', () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,3 @@
 keep
-old
+neu
 keep2
`;
    const d = parseUnifiedDiff(diff);
    const changed = changedLinesByPath(d);
    expect(changed.get('x.ts')!.added.has(2)).toBe(true);
    expect(changed.get('x.ts')!.deleted.has(2)).toBe(true);
    expect(isChangedLine(changed, 'x.ts', 'head', 2)).toBe(true);
    expect(isChangedLine(changed, 'x.ts', 'head', 1)).toBe(false);
  });

  it('生成文件识别 + 多文件', () => {
    const diff = `diff --git a/dist/app.min.js b/dist/app.min.js
--- a/dist/app.min.js
+++ b/dist/app.min.js
@@ -1 +1 @@
-a
+b
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
`;
    const d = parseUnifiedDiff(diff);
    expect(d.files).toHaveLength(2);
    expect(d.files[0]!.isGenerated).toBe(true);
    expect(d.files[1]!.isGenerated).toBe(false);
    expect(d.stats.filesChanged).toBe(2);
  });

  it('忽略 no-newline 标记', () => {
    const diff = `diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file
`;
    const f = parseUnifiedDiff(diff).files[0]!;
    const kinds = f.hunks[0]!.lines.map((l) => l.kind);
    expect(kinds).toEqual(['deleted', 'added']);
  });
});

// git quotes paths with non-ASCII bytes, quotes or backslashes in both `diff --git` and `---`/`+++`.
describe('quoted path(非 ASCII / 特殊字符文件名)', () => {
  it('八进制转义按**字节**攒起来再按 UTF-8 解 —— 逐字符转会得到乱码', () => {
    expect(unquotePath('"docs/adr/047-\\346\\224\\257\\344\\273\\230\\345\\256\\235.md"')).toBe('docs/adr/047-支付宝.md');
  });

  it('简单转义与非引号路径原样', () => {
    expect(unquotePath('"a b\\tc"')).toBe('a b\tc');
    expect(unquotePath('"say \\"hi\\""')).toBe('say "hi"');
    expect(unquotePath('"back\\\\slash"')).toBe('back\\slash');
    expect(unquotePath('plain/path.ts')).toBe('plain/path.ts');
  });

  it('引号形态的 diff 头 → 路径解出真名(此前整串带着转义流到 PR 评论里)', () => {
    const diff = [
      'diff --git "a/docs/\\346\\224\\257.md" "b/docs/\\346\\224\\257.md"',
      'index 111..222 100644',
      '--- "a/docs/\\346\\224\\257.md"',
      '+++ "b/docs/\\346\\224\\257.md"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff, {});
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.newPath).toBe('docs/支.md');
    expect(parsed.files[0]!.oldPath).toBe('docs/支.md');
  });

  it('重命名成非 ASCII 名字 → 新旧两侧都解出真名', () => {
    const diff = [
      'diff --git "a/old.md" "b/\\346\\226\\260.md"',
      'similarity index 90%',
      'rename from "old.md"',
      'rename to "\\346\\226\\260.md"',
    ].join('\n');
    const parsed = parseUnifiedDiff(diff, {});
    expect(parsed.files[0]!.status).toBe('renamed');
    expect(parsed.files[0]!.oldPath).toBe('old.md');
    expect(parsed.files[0]!.newPath).toBe('新.md');
  });
});
