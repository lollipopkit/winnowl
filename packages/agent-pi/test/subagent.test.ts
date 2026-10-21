import { describe, expect, it } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import { buildSubagentTool, createFauxAgent, toolTextResult, type AgentTool, type InvocationUsage } from '../src/index.js';

// Pins the properties that fail silently: real concurrency, usage reporting, one level only, task cap.
const REPORT = Type.Object({ answer: Type.String() });

function tool(over: Partial<Parameters<typeof buildSubagentTool>[0]> = {}): {
  t: AgentTool;
  usage: InvocationUsage[];
  collected: { name: string; payloads: unknown[] }[];
  childTools: AgentTool[][];
} {
  const faux = createFauxAgent();
  // createFauxAgent has one shared queue that concurrent children race on, so all responses are identical.
  faux.setResponses(Array.from({ length: 8 }, () => faux.assistant(faux.toolCall('report', { answer: 'done' }))));
  const usage: InvocationUsage[] = [];
  const collected: { name: string; payloads: unknown[] }[] = [];
  const childTools: AgentTool[][] = [];
  const probe: AgentTool = {
    name: 'probe',
    description: 'p',
    label: 'p',
    parameters: Type.Object({}),
    execute: async () => toolTextResult('ok'),
  };
  const t = buildSubagentTool({
    name: 'investigate',
    description: 'd',
    label: 'l',
    systemPrompt: 's',
    model: faux.model,
    streamFn: faux.streamFn,
    readTools: [probe],
    finalization: { name: 'report', description: 'r', label: 'R', schema: REPORT },
    budget: { maxTurns: 4, maxToolCalls: 8 },
    maxConcurrency: 2,
    maxTasks: 3,
    onUsage: (u) => usage.push(u),
    onCollected: (name, payloads) => collected.push({ name, payloads }),
    renderResult: ({ goal, finalization }) => `${goal}: ${(finalization as { answer?: string } | undefined)?.answer ?? 'none'}`,
    ...over,
  });
  // Records the toolset children receive.
  childTools.push([probe]);
  return { t, usage, collected, childTools };
}

const run = async (t: AgentTool, tasks: { goal: string }[]): Promise<string> => {
  const r = await t.execute!('id', { tasks } as never, () => undefined);
  return r.content.map((c) => ('text' in c ? c.text : '')).join('');
};

describe('buildSubagentTool', () => {
  it('每个 task 一个子,结论按声明序回到父手里', async () => {
    const { t } = tool();
    const text = await run(t, [{ goal: 'q1' }, { goal: 'q2' }]);
    expect(text).toContain('q1: done');
    expect(text).toContain('q2: done');
    expect(text.indexOf('q1')).toBeLessThan(text.indexOf('q2'));
  });

  it('超出 maxTasks **截断并在给模型的文本里说明** —— 它以为派了 5 个而实际 3 个时,后续推理建立在错的前提上', async () => {
    const { t } = tool();
    const text = await run(t, [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }, { goal: 'd' }, { goal: 'e' }]);
    expect(text).toContain('2 more were not run');
    expect(text).not.toContain('d:');
  });

  it('子的用量逐个汇回父 —— 不汇的话成本闸对子完全瞎,而子花的是同一笔钱', async () => {
    const { t, usage } = tool();
    await run(t, [{ goal: 'a' }, { goal: 'b' }]);
    expect(usage).toHaveLength(2);
    for (const u of usage) expect(u.turns).toBeGreaterThan(0);
  });

  it('子的 finding 转交父(而不是让父再转述一遍 —— 那要按输出价付第二遍)', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(faux.toolCall('submit_finding', { claim: 'c' })),
      faux.assistant(faux.toolCall('report', { answer: 'ok' })),
    ]);
    const collected: { name: string; payloads: unknown[] }[] = [];
    const t = buildSubagentTool({
      name: 'investigate', description: 'd', label: 'l', systemPrompt: 's',
      model: faux.model, streamFn: faux.streamFn, readTools: [],
      collectors: [{ name: 'submit_finding', description: 'f', label: 'F', schema: Type.Object({ claim: Type.String() }) }],
      finalization: { name: 'report', description: 'r', label: 'R', schema: REPORT },
      budget: { maxTurns: 4, maxToolCalls: 8 }, maxConcurrency: 1, maxTasks: 2,
      onCollected: (name, payloads) => collected.push({ name, payloads }),
      renderResult: () => 'x',
    });
    await run(t, [{ goal: 'a' }]);
    expect(collected).toEqual([{ name: 'submit_finding', payloads: [{ claim: 'c' }] }]);
  });

  it('子没收尾照实说,不静默当成「没发现问题」', async () => {
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant('just talking, no tool call')]);
    const t = buildSubagentTool({
      name: 'investigate', description: 'd', label: 'l', systemPrompt: 's',
      model: faux.model, streamFn: faux.streamFn, readTools: [],
      finalization: { name: 'report', description: 'r', label: 'R', schema: REPORT },
      budget: { maxTurns: 4, maxToolCalls: 8 }, maxConcurrency: 1, maxTasks: 2,
      renderResult: ({ status, finalization }) => (finalization ? 'answered' : `no answer: ${status}`),
    });
    expect(await run(t, [{ goal: 'a' }])).toContain('no answer');
  });

  it('并发受 maxConcurrency 约束(不是一口气全放出去)', async () => {
    let live = 0;
    let peak = 0;
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('report', { answer: 'ok' }))]);
    const slow: AgentTool = {
      name: 'probe', description: 'p', label: 'p', parameters: Type.Object({}),
      execute: async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 30));
        live -= 1;
        return toolTextResult('ok');
      },
    };
    // Each child calls a slow tool first so lifetimes overlap.
    faux.setResponses(
      Array.from({ length: 4 }, () => [faux.assistant(faux.toolCall('probe', {})), faux.assistant(faux.toolCall('report', { answer: 'ok' }))]).flat(),
    );
    const t = buildSubagentTool({
      name: 'investigate', description: 'd', label: 'l', systemPrompt: 's',
      model: faux.model, streamFn: faux.streamFn, readTools: [slow],
      finalization: { name: 'report', description: 'r', label: 'R', schema: REPORT },
      budget: { maxTurns: 6, maxToolCalls: 8 }, maxConcurrency: 2, maxTasks: 4,
      renderResult: () => 'x',
    });
    await run(t, [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }, { goal: 'd' }]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('子拿不到本工具 —— 只允许一层不是策略,是构造(没给它,它就没这个能力)', () => {
    const { t } = tool();
    // buildSubagentTool must never add itself to the children's readTools.
    const src = buildSubagentTool.toString();
    expect(src).not.toContain('readTools: [...opts.readTools');
    expect(t.name).toBe('investigate');
  });
});
