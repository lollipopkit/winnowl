import { describe, expect, it, vi } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import type { RetrievalItem } from '@reviewbot/knowledge';
import { selectKnowledge } from '../src/knowledge-select.js';

const budget = { maxTurns: 2, maxToolCalls: 2 };

function item(id: string, opts: Partial<RetrievalItem> = {}): RetrievalItem {
  return { id, category: 'approved-learning', content: `rule ${id}`, ...opts };
}

describe('selectKnowledge(§知识库重构 P2)', () => {
  it('候选 ≤ 阈值 → 全注入,不调 LLM(含未命中文件的 path 规则)', async () => {
    const faux = createFauxAgent(); // no responses: any LLM call would fail
    const candidates = [item('a'), item('b', { selector: 'src/x/**' }), item('c')];
    const res = await selectKnowledge(candidates, {
      model: faux.model,
      streamFn: faux.streamFn,
      budget,
      changedPaths: ['src/y/z.ts'], // b does not match but is still injected under the threshold
      injectAllThreshold: 12,
    });
    expect(res.llmSelected).toBe(false);
    expect(res.items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    expect(res.usedIds).toHaveLength(3);
  });

  it('> 阈值 → LLM 选子集;mandatory / none-locality(无 selector)恒保留', async () => {
    const faux = createFauxAgent();
    const selectable = Array.from({ length: 10 }, (_, i) => item(`s${i}`, { selector: `src/f${i}/**` }));
    const candidates = [item('m1', { selector: 'src/z/**', mandatory: true }), item('n1'), ...selectable];
    faux.setResponses([faux.assistant(faux.toolCall('select_knowledge', { selectedIds: ['s0', 's3'] }))]);
    const res = await selectKnowledge(candidates, {
      model: faux.model,
      streamFn: faux.streamFn,
      budget,
      changedPaths: ['src/f0/a.ts'],
      injectAllThreshold: 5,
    });
    expect(res.llmSelected).toBe(true);
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain('m1');
    expect(ids).toContain('n1');
    expect(ids).toContain('s0');
    expect(ids).toContain('s3');
    expect(ids).not.toContain('s1');
  });

  it('LLM 未完成 → 回退 file-matched(不丢与变更文件相关的规则)', async () => {
    const faux = createFauxAgent();
    const candidates = [item('n1'), ...Array.from({ length: 10 }, (_, i) => item(`s${i}`, { selector: `src/f${i}/**` }))];
    faux.setResponses([faux.assistant('I could not decide.')]); // no finalization → incomplete
    const res = await selectKnowledge(candidates, {
      model: faux.model,
      streamFn: faux.streamFn,
      budget,
      changedPaths: ['src/f2/x.ts'],
      injectAllThreshold: 5,
    });
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain('n1');
    expect(ids).toContain('s2'); // file-matched fallback
    expect(ids).not.toContain('s0');
  });

  it('> cap → 截断 + log(不静默丢)', async () => {
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('select_knowledge', { selectedIds: [] }))]);
    const candidates = Array.from({ length: 20 }, (_, i) => item(`s${i}`, { selector: `src/f${i}/**` }));
    const log = vi.fn();
    await selectKnowledge(candidates, {
      model: faux.model,
      streamFn: faux.streamFn,
      budget,
      changedPaths: ['src/f0/a.ts'],
      injectAllThreshold: 5,
      selectCap: 8,
      log,
    });
    expect(log).toHaveBeenCalledWith('knowledge candidates truncated before selection', expect.objectContaining({ dropped: 12 }));
  });

  it('过期项被剔除', async () => {
    const faux = createFauxAgent();
    const candidates = [item('a'), item('expired', { expiresAt: 1 })];
    const res = await selectKnowledge(candidates, {
      model: faux.model,
      streamFn: faux.streamFn,
      budget,
      changedPaths: [],
      injectAllThreshold: 12,
      now: 1000,
    });
    expect(res.items.map((i) => i.id)).toEqual(['a']);
  });
});
