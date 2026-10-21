import { describe, expect, it } from 'vitest';
import type { KnowledgeToolEntry } from '@reviewbot/agent-pi';
import { openingOf, RULE_INLINE_MAX, ruleLine } from '../src/knowledge-inline.js';

describe('ruleLine (long rules on demand)', () => {
  it('keeps typical rules inline and records nothing', () => {
    const entries: KnowledgeToolEntry[] = [];
    expect(ruleLine({ id: 'a', content: 'Use pnpm, never npm.' }, entries)).toBe('- Use pnpm, never npm.');
    expect(entries).toEqual([]);
  });

  it('lists a long rule by its opening sentence plus a read pointer and keeps the full text', () => {
    const entries: KnowledgeToolEntry[] = [];
    const content = `Migrate widgets to material_ui 2. ${'Step details. '.repeat(40)}`;
    expect(content.length).toBeGreaterThan(RULE_INLINE_MAX);
    expect(ruleLine({ id: 'r-9', content }, entries)).toBe('- Migrate widgets to material_ui 2. [read: knowledge_read r-9]');
    expect(entries).toEqual([{ id: 'r-9', kind: 'rule', title: 'Migrate widgets to material_ui 2.', body: content }]);
  });

  it('cuts an opening without a sentence end and marks the cut', () => {
    const opening = openingOf('x'.repeat(500));
    expect(opening.endsWith('…')).toBe(true);
    expect(opening.length).toBe(201);
    expect(openingOf('迁移到新的主题系统。然后再改颜色。')).toBe('迁移到新的主题系统。');
  });
});
