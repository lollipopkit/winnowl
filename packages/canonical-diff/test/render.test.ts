import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, renderFilePatch } from '../src/index.js';

describe('renderFilePatch', () => {
  it('round-trips modified, deleted and renamed files', () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@ function f() {
 line1
-line2
+line2-changed
 line3
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const x = 1;
-export const y = 2;
diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
`;
    const [modified, deleted, renamed] = parseUnifiedDiff(diff).files;
    expect(renderFilePatch(modified!)).toBe(
      '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@ function f() {\n line1\n-line2\n+line2-changed\n line3',
    );
    expect(renderFilePatch(deleted!)).toBe(
      '--- a/src/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-export const x = 1;\n-export const y = 2;',
    );
    expect(renderFilePatch(renamed!)).toBe('--- a/old.ts\n+++ b/new.ts\n@@ -1,1 +1,1 @@\n-a\n+b');
  });
});
