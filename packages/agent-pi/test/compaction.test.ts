import { describe, expect, it } from 'vitest';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, Type, type Model } from '@earendil-works/pi-ai';
import { buildSourceTools, compactMessages, runAgentInvocation, type SourceProvider } from '../src/index.js';

const user = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: 0 }) as unknown as AgentMessage;
const call = (id: string): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read_source', arguments: { path: `${id}.ts` } }], timestamp: 0 }) as unknown as AgentMessage;
const result = (id: string, chars: number): AgentMessage =>
  ({ role: 'toolResult', toolCallId: id, toolName: 'read_source', content: [{ type: 'text', text: 'x'.repeat(chars) }], isError: false, timestamp: 0 }) as unknown as AgentMessage;
const textOf = (m: AgentMessage) => ((m as { content: { text?: string }[] }).content[0]?.text ?? '');

/** A task plus n read_source call/result pairs of `chars` characters each (~chars/4 tokens). */
const transcript = (n: number, chars: number): AgentMessage[] => [
  user('review the scope'),
  ...Array.from({ length: n }, (_, i) => [call(`c${i}`), result(`c${i}`, chars)]).flat(),
];

describe('compactMessages(§4.1 上下文压缩)', () => {
  it('没越过阈值 → 原样返回', () => {
    const msgs = transcript(4, 400);
    expect(compactMessages(msgs, 100_000)).toEqual({ messages: msgs, elided: 0 });
  });

  it('越过阈值 → 从最早的工具输出开始省略,最近的消息与配对不动,且可重入', () => {
    const msgs = transcript(10, 4000); // ~10k tokens
    const { messages, elided } = compactMessages(msgs, 10_000);
    expect(elided).toBeGreaterThan(0);
    expect(messages).toHaveLength(msgs.length);
    expect(textOf(messages[2]!)).toMatch(/^\[elided to save context: read_source output, 4000 characters/);
    expect((messages[2] as { toolCallId: string }).toolCallId).toBe('c0');
    for (const m of messages.slice(-6)) if ((m as { role: string }).role === 'toolResult') expect(textOf(m)).toHaveLength(4000);
    expect(messages[0]).toBe(msgs[0]);
    expect(messages[1]).toBe(msgs[1]);
    // Input is not mutated, and rerunning on the original yields the same cut.
    expect(textOf(msgs[2]!)).toHaveLength(4000);
    expect(compactMessages(msgs, 10_000).elided).toBe(elided);
  });

  it('窗口未知(模型元数据缺失)→ 不动', () => {
    const msgs = transcript(10, 4000);
    expect(compactMessages(msgs, 0).elided).toBe(0);
  });
});

describe('runAgentInvocation 接上压缩', () => {
  it('越过窗口时发给模型的请求里,早期工具输出已被省略', async () => {
    const big = 'y'.repeat(6000);
    const source: SourceProvider = {
      listChangedFiles: async () => [{ path: 'a.ts', status: 'modified' }],
      readFile: async () => big,
      searchCode: async () => [],
    };
    const core = createFauxCore({ provider: 'faux', api: 'faux-api', models: [{ id: 'faux-1' }] });
    const model = { ...(core.getModel() as Model<string>), contextWindow: 8000 };
    core.setResponses([
      ...Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(fauxToolCall('read_source', { path: `a${i}.ts` }))),
      fauxAssistantMessage(fauxToolCall('submit_note', { note: 'done' })),
    ]);
    let lastRequest: unknown[] = [];
    const streamFn = ((m: unknown, ctx: unknown, o: unknown) => {
      lastRequest = (ctx as { messages: unknown[] }).messages;
      return (core.streamSimple as (...a: unknown[]) => unknown)(m, ctx, o);
    }) as unknown as StreamFn;
    const r = await runAgentInvocation({
      systemPrompt: 'stage',
      task: 'Review',
      model,
      streamFn,
      readTools: buildSourceTools(source),
      finalization: { name: 'submit_note', description: 'd', label: 'l', schema: Type.Object({ note: Type.String() }) },
      budget: { maxTurns: 20, maxToolCalls: 20 },
    });
    expect(r.status).toBe('complete');
    expect(r.elidedToolResults).toBeGreaterThan(0);
    expect(JSON.stringify(lastRequest)).toContain('[elided to save context: read_source output');
  });
});
