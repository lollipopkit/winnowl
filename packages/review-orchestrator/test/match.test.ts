import { describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import { matchPriorFindings, type MatchPrior, type MatchSubject } from '../src/match.js';

// Cross-round identity. Accuracy is a live-regression concern; this pins the code-side guards:
// reported ids must exist, links are one-to-one, and failure falls back to strong-fingerprint equality.
describe('matchPriorFindings(跨轮 finding 身份)', () => {
  const BUDGET = { maxTurns: 2, maxToolCalls: 2 };

  // Real claims: identical anchor_text, reworded claim; strong fingerprint misses and token-Dice is only 0.444.
  const subject: MatchSubject = {
    id: 'c1',
    category: 'correctness',
    claim: 'killSession can execute a different tmux binary than the one discovered for the control session',
    path: 'lib/data/ssh/tmux/tmux_session_scanner.dart',
    codeWindow: "tmuxBin: _tmuxBin ?? 'tmux'",
    fingerprint: 'fp-current',
  };
  const prior: MatchPrior = {
    findingId: 'f-old',
    category: 'correctness',
    claim: '`killSession` can execute the wrong tmux binary because it skips binary resolution',
    fingerprint: 'fp-prior',
    path: 'lib/view/widget/tmux_session_selector.dart', // Cross-file: the code moved.
    codeWindow: "tmuxBin: _tmuxBin ?? 'tmux'",
  };

  const faux = (links: unknown[]): { model: never; streamFn: never } => {
    const a = createFauxAgent();
    a.setResponses([a.assistant(a.toolCall('submit_links', { links }))]);
    return { model: a.model as never, streamFn: a.streamFn as never };
  };

  // Captures the prompt sent to the model; which items made it in is not visible from the return value.
  const capturing = (links: unknown[]) => {
    const a = createFauxAgent();
    a.setResponses([a.assistant(a.toolCall('submit_links', { links }))]);
    let seen = '';
    const streamFn = ((...args: unknown[]) => {
      seen += JSON.stringify(args, (_k, v) => (typeof v === 'function' ? '[fn]' : v));
      return (a.streamFn as unknown as (...a: unknown[]) => unknown)(...args);
    }) as never;
    return { model: a.model as never, streamFn, prompt: (): string => seen };
  };

  // Counts model calls; whether the LLM ran cannot be inferred from results (the fallback may match).
  const counting = (links: unknown[]) => {
    const a = createFauxAgent();
    a.setResponses([a.assistant(a.toolCall('submit_links', { links }))]);
    let calls = 0;
    const streamFn = ((...args: unknown[]) => {
      calls += 1;
      return (a.streamFn as unknown as (...a: unknown[]) => unknown)(...args);
    }) as never;
    return { model: a.model as never, streamFn, calls: () => calls };
  };

  it('LLM 给的链接生效,且跨文件也算(重构搬家正是要认出来的一类)', async () => {
    const m = await matchPriorFindings([subject], [prior], {
      ...faux([{ currentId: 'c1', priorId: 'f-old', reason: 'same tmux binary resolution defect' }]),
      budget: BUDGET,
    });
    expect(m.get('c1')).toEqual({ priorFindingId: 'f-old', priorFingerprint: 'fp-prior', method: 'llm' });
  });

  it('id 不存在的链接一律丢弃(模型可能凭空造 id)', async () => {
    const m = await matchPriorFindings([subject], [prior], {
      ...faux([
        { currentId: 'nope', priorId: 'f-old', reason: 'x' },
        { currentId: 'c1', priorId: 'f-nope', reason: 'x' },
      ]),
      budget: BUDGET,
    });
    expect(m.size).toBe(0);
  });

  it('1:1:两条候选连同一个历史项 → 只认第一条,另一条仍是新问题', async () => {
    const s2: MatchSubject = { ...subject, id: 'c2', claim: 'another defect in the same scanner', fingerprint: 'fp-c2' };
    const m = await matchPriorFindings([subject, s2], [prior], {
      ...faux([
        { currentId: 'c1', priorId: 'f-old', reason: 'x' },
        { currentId: 'c2', priorId: 'f-old', reason: 'x' },
      ]),
      budget: BUDGET,
    });
    expect(m.get('c1')?.priorFindingId).toBe('f-old');
    expect(m.has('c2')).toBe(false);
  });

  it('判不了时回退强指纹相等 —— 退回今天的行为,而不是把老问题全当新的', async () => {
    const a = createFauxAgent();
    a.setResponses([a.assistant('没有调用 submit_links,于是 status 非 complete')]);
    const sameFp: MatchSubject = { ...subject, fingerprint: 'fp-prior' };
    const m = await matchPriorFindings([sameFp], [prior], {
      model: a.model as never,
      streamFn: a.streamFn as never,
      budget: BUDGET,
    });
    expect(m.get('c1')).toEqual({ priorFindingId: 'f-old', priorFingerprint: 'fp-prior', method: 'fingerprint' });
  });

  it('回退时指纹也对不上 → 判新问题(不猜)', async () => {
    const a = createFauxAgent();
    a.setResponses([a.assistant('no tool call')]);
    const m = await matchPriorFindings([subject], [prior], {
      model: a.model as never,
      streamFn: a.streamFn as never,
      budget: BUDGET,
    });
    expect(m.size).toBe(0);
  });

  it('fastPath 开启:强指纹相同的直接连,模型一次都不问', async () => {
    const c = counting([]); // The model would answer "no link" if asked.
    const sameFp: MatchSubject = { ...subject, fingerprint: 'fp-prior' };
    const m = await matchPriorFindings([sameFp], [prior], { model: c.model, streamFn: c.streamFn, budget: BUDGET, fastPath: true });
    expect(m.get('c1')).toEqual({ priorFindingId: 'f-old', priorFingerprint: 'fp-prior', method: 'fingerprint' });
    expect(c.calls()).toBe(0);
  });

  it('fastPath 关闭(默认):强指纹相同也交给 LLM 判,它说不连就不连', async () => {
    const c = counting([]);
    const sameFp: MatchSubject = { ...subject, fingerprint: 'fp-prior' };
    const m = await matchPriorFindings([sameFp], [prior], { model: c.model, streamFn: c.streamFn, budget: BUDGET });
    expect(m.size).toBe(0); // Same input as above, opposite result: the toggle works.
    expect(c.calls()).toBe(1);
  });

  it('任一侧为空 → 不调用模型,直接空结果', async () => {
    const c1 = counting([{ currentId: 'c1', priorId: 'f-old', reason: 'x' }]);
    expect((await matchPriorFindings([], [prior], { model: c1.model, streamFn: c1.streamFn, budget: BUDGET })).size).toBe(0);
    expect(c1.calls()).toBe(0);
    const c2 = counting([{ currentId: 'c1', priorId: 'f-old', reason: 'x' }]);
    expect((await matchPriorFindings([subject], [], { model: c2.model, streamFn: c2.streamFn, budget: BUDGET })).size).toBe(0);
    expect(c2.calls()).toBe(0);
  });

  // The size cap recalls by relevance and must report every dropped item via onTruncate,
  // including other-category items.
  it('超出 maxItems:按相关性排序后截断,丢了多少如实报出', async () => {
    const many: MatchPrior[] = Array.from({ length: 20 }, (_, i) => ({
      ...prior,
      findingId: `f${i}`,
      fingerprint: `fp${i}`,
      // Half are another category: lower relevance, cut first, still counted as dropped.
      category: i % 2 === 0 ? 'correctness' : 'style',
    }));
    let dropped = -1;
    const cap = capturing([{ currentId: 'c1', priorId: 'f0', reason: 'x' }]);
    const m = await matchPriorFindings([subject], many, {
      model: cap.model,
      streamFn: cap.streamFn,
      budget: BUDGET,
      maxItems: 6,
      onTruncate: (n) => (dropped = n),
    });
    expect(dropped).toBe(15); // 20 priors, subjects take 1 -> 5 kept.
    // The kept ones must be the same-category batch, not the first 5 by load order.
    expect(cap.prompt()).toContain('f0');
    expect(cap.prompt()).not.toContain('f1 |');
    expect(m.get('c1')?.priorFindingId).toBe('f0');
  });

  // Truncation must rank same-file priors first; otherwise priors for this round's files rarely reach the prompt.
  it('截断优先保留与本轮同文件的历史项(不按加载顺序切)', async () => {
    const others: MatchPrior[] = Array.from({ length: 20 }, (_, i) => ({
      ...prior,
      findingId: `other${i}`,
      fingerprint: `fp-other${i}`,
      path: `lib/unrelated/file${i}.dart`,
    }));
    // The same-file prior is last, so load-order truncation would cut it.
    const sameFile: MatchPrior = { ...prior, findingId: 'f-samefile', fingerprint: 'fp-samefile', path: subject.path };
    // Assert on the prompt, not the result: id validation uses all priors, so a truncated item would still pass.
    const cap = capturing([{ currentId: 'c1', priorId: 'f-samefile', reason: 'same defect' }]);
    const m = await matchPriorFindings([subject], [...others, sameFile], {
      model: cap.model,
      streamFn: cap.streamFn,
      budget: BUDGET,
      maxItems: 4, // 1 subject -> only 3 priors kept.
    });
    expect(cap.prompt()).toContain('f-samefile');
    expect(cap.prompt()).not.toContain('other19');
    expect(m.get('c1')?.priorFindingId).toBe('f-samefile');
  });
});
