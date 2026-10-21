import { describe, expect, it } from 'vitest';
import { buildKnowledgeTools, KNOWLEDGE_TOOL_NAMES, type KnowledgeToolEntry } from '../src/tools.js';

const ENTRIES: KnowledgeToolEntry[] = [
  { id: 'r1', kind: 'rule', title: 'Migrate to material_ui 2.', body: 'Migrate to material_ui 2. Step 1 … step 9.' },
  { id: 'f1', kind: 'fact', title: '[pub] flutter: Material moved', body: 'Long migration guide text' },
];

async function text(result: { content: { type: string; text?: string }[] }): Promise<string> {
  return result.content[0]!.text ?? '';
}

describe('buildKnowledgeTools (knowledge_read)', () => {
  it('returns the full text by id, trims the id, and reports unknown ids', async () => {
    const [read] = buildKnowledgeTools(ENTRIES);
    expect(read!.name).toBe('knowledge_read');
    const out = await text(await read!.execute('t', { id: ' r1 ' }, undefined as never, undefined as never));
    expect(out).toBe('[rule] Migrate to material_ui 2.\n\nMigrate to material_ui 2. Step 1 … step 9.');
    expect(await text(await read!.execute('t', { id: 'nope' }, undefined as never, undefined as never))).toContain('not found');
  });

  it('caps reads per review (misses do not count)', async () => {
    const [read] = buildKnowledgeTools(ENTRIES, { maxReads: 1 });
    await read!.execute('t', { id: 'nope' }, undefined as never, undefined as never);
    await read!.execute('t', { id: 'r1' }, undefined as never, undefined as never);
    expect(await text(await read!.execute('t', { id: 'f1' }, undefined as never, undefined as never))).toContain('limit reached');
  });

  it('offers no tool when nothing is shortened', () => {
    expect(buildKnowledgeTools([])).toEqual([]);
    expect(KNOWLEDGE_TOOL_NAMES).toEqual(['knowledge_read']);
  });
});
