import { describe, expect, it } from 'vitest';
import { buildDiffTool } from '../src/tools.js';

async function call(tool: ReturnType<typeof buildDiffTool>[number], params: object): Promise<string> {
  const r = await tool.execute('t', params, undefined as never, undefined as never);
  return (r.content[0] as { text?: string }).text ?? '';
}

describe('buildDiffTool (read_diff)', () => {
  const long = Array.from({ length: 450 }, (_, i) => `-line ${i + 1}`).join('\n');
  const [readDiff] = buildDiffTool({ 'src/a.ts': '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b', 'gone.ts': long });

  it('returns a changed file\'s diff, normalising the path', async () => {
    expect(readDiff!.name).toBe('read_diff');
    expect(await call(readDiff!, { path: './src/a.ts' })).toBe('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b');
  });

  it('pages long diffs and says where to continue', async () => {
    const first = await call(readDiff!, { path: 'gone.ts' });
    expect(first).toContain('-line 400\n(lines 1-400 of 450; call read_diff with startLine=401 for more)');
    const rest = await call(readDiff!, { path: 'gone.ts', startLine: 401 });
    expect(rest.startsWith('-line 401\n')).toBe(true);
    expect(rest.endsWith('-line 450')).toBe(true);
  });

  it('points to read_source for a path without a diff', async () => {
    expect(await call(readDiff!, { path: 'other.ts' })).toContain('no diff for other.ts');
  });
});
