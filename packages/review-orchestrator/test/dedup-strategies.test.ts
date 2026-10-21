import { describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import { cosineSimilarity, createEmbeddingDeduper, createLlmDeduper, tokenDiceStrategy, type DedupCandidate } from '../src/index.js';

describe('DedupStrategy(§加速#2 可插拔去重)', () => {
  const A: DedupCandidate = { id: 'a', path: 'f.ts', claim: 'off by one in add returns a plus b plus one instead of a plus b' };
  const B: DedupCandidate = { id: 'b', path: 'f.ts', claim: 'off by one in add returns a plus b plus one rather than a plus b' };
  const C: DedupCandidate = { id: 'c', path: 'g.ts', claim: 'null dereference in parse when input is empty' };

  it('cosineSimilarity:同向=1,正交=0,零向量=0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('tokenDiceStrategy(incremental):同文件相似→重复,跨文件→否', async () => {
    const s = tokenDiceStrategy();
    expect(s.kind).toBe('incremental');
    if (s.kind !== 'incremental') throw new Error('expected incremental');
    expect(await s.isDuplicate(B, [A])).toBe(true); // Same file, near-identical wording.
    expect(await s.isDuplicate(C, [A])).toBe(false); // Cross-file.
    expect(await s.isDuplicate(A, [])).toBe(false); // No survivors.
  });

  it('createEmbeddingDeduper(incremental):同文件 cosine≥阈值→重复,跨文件→否', async () => {
    // Fake embed: A/B nearly parallel (cosine ~0.99), C orthogonal.
    const vec: Record<string, number[]> = {
      [A.claim]: [1, 0, 0],
      [B.claim]: [0.99, 0.14, 0],
      [C.claim]: [0, 0, 1],
    };
    const s = createEmbeddingDeduper({ embed: async (t) => vec[t] ?? [0, 0, 0], threshold: 0.9 });
    if (s.kind !== 'incremental') throw new Error('expected incremental');
    expect(await s.isDuplicate(A, [])).toBe(false); // First candidate; embeds and caches A.
    expect(await s.isDuplicate(B, [A])).toBe(true); // Same file as A, cosine ~0.99 >= 0.9.
    expect(await s.isDuplicate(C, [A])).toBe(false); // C is in g.ts; cross-file is not compared.
  });

  it('createLlmDeduper(batch):聚类返回 suppressed;校验 id、忽略幻觉、保 keepId', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(
        faux.toolCall('submit_dedup', {
          duplicateGroups: [{ keepId: 'a', duplicateIds: ['b', 'zzz-not-real', 'a'] }], // b is real -> suppressed; hallucinated ids and keepId itself are ignored.
        }),
      ),
    ]);
    const s = createLlmDeduper({ model: faux.model, streamFn: faux.streamFn, budget: { maxTurns: 4, maxToolCalls: 8 } });
    if (s.kind !== 'batch') throw new Error('expected batch');
    expect(await s.dedupe([A, B, C])).toEqual(new Set(['b']));
  });

  it('createLlmDeduper:<2 候选直接返回空(不调用 LLM)', async () => {
    const faux = createFauxAgent(); // No responses: an unexpected LLM call would hang/time out.
    const s = createLlmDeduper({ model: faux.model, streamFn: faux.streamFn, budget: { maxTurns: 4, maxToolCalls: 8 } });
    if (s.kind !== 'batch') throw new Error('expected batch');
    expect(await s.dedupe([A])).toEqual(new Set());
  });

  it('createLlmDeduper:keepId 不存在的组整组不信(不误抑制)', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(faux.toolCall('submit_dedup', { duplicateGroups: [{ keepId: 'ghost', duplicateIds: ['a', 'b'] }] })),
    ]);
    const s = createLlmDeduper({ model: faux.model, streamFn: faux.streamFn, budget: { maxTurns: 4, maxToolCalls: 8 } });
    if (s.kind !== 'batch') throw new Error('expected batch');
    expect(await s.dedupe([A, B, C])).toEqual(new Set()); // Hallucinated keepId -> whole group dropped.
  });
});
