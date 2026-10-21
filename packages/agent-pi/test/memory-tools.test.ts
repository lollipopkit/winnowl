import { describe, expect, it } from 'vitest';
import { buildMemoryTools, MEMORY_TOOL_NAMES, type MemoryToolEntry } from '../src/tools.js';

const ENTRIES: MemoryToolEntry[] = [
  { id: 'm1', kind: 'repo-quirk', title: 'build needs pnpm', summary: '必须 pnpm', body: 'workspace 协议详情', links: ['m2'] },
  { id: 'm2', kind: 'false-positive-pattern', title: 'retry loop', summary: '重试非 bug', body: '幂等由 D-007 保证', links: [] },
];

async function text(result: { content: { type: string; text?: string }[] }): Promise<string> {
  return result.content[0]!.text ?? '';
}

describe('buildMemoryTools', () => {
  it('memory_index:每条一行 id/kind/title/summary;空集有占位', async () => {
    const [index] = buildMemoryTools(ENTRIES);
    const out = await text(await index!.execute('t', {}, undefined as never, undefined as never));
    expect(out).toContain('m1\t[repo-quirk] build needs pnpm — 必须 pnpm');
    expect(out.split('\n')).toHaveLength(2);
    const [emptyIndex] = buildMemoryTools([]);
    expect(await text(await emptyIndex!.execute('t', {}, undefined as never, undefined as never))).toBe('(no memories)');
  });

  it('memory_read:按 id 取 body + related;未知 id → not found', async () => {
    const [, read] = buildMemoryTools(ENTRIES);
    const out = await text(await read!.execute('t', { id: 'm1' }, undefined as never, undefined as never));
    expect(out).toContain('workspace 协议详情');
    expect(out).toContain('related: m2');
    expect(await text(await read!.execute('t', { id: 'nope' }, undefined as never, undefined as never))).toContain('not found');
  });

  it('memory_read:超 maxReads 后拒绝(不计未命中)', async () => {
    const [, read] = buildMemoryTools(ENTRIES, { maxReads: 1 });
    await read!.execute('t', { id: 'nope' }, undefined as never, undefined as never); // misses do not count
    await read!.execute('t', { id: 'm1' }, undefined as never, undefined as never);
    const out = await text(await read!.execute('t', { id: 'm2' }, undefined as never, undefined as never));
    expect(out).toContain('memory read limit reached');
  });

  it('工具名与 §15.5 只读契约:仅 index/read 两个', () => {
    const tools = buildMemoryTools(ENTRIES);
    expect(tools.map((t) => t.name)).toEqual([...MEMORY_TOOL_NAMES]);
  });
});
