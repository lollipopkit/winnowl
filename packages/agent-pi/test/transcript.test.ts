import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { pruneFinalizationCalls } from '../src/transcript.js';

// Minimal objects cast to AgentMessage; only role/content/type/name/id/toolName/toolCallId are read.
const user = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: 0 }) as unknown as AgentMessage;
const asst = (content: unknown[]): AgentMessage => ({ role: 'assistant', content, timestamp: 0 }) as unknown as AgentMessage;
const text = (t: string) => ({ type: 'text', text: t });
const toolCall = (name: string, id: string) => ({ type: 'toolCall', id, name, arguments: {} });
const toolResult = (toolName: string, toolCallId: string): AgentMessage =>
  ({ role: 'toolResult', toolName, toolCallId, content: [], isError: false, timestamp: 0 }) as unknown as AgentMessage;

const roles = (ms: AgentMessage[]) => ms.map((m) => (m as { role: string }).role);
const contentTypes = (m: AgentMessage) => ((m as { content: { type: string }[] }).content).map((c) => c.type);

describe('pruneFinalizationCalls(§session-reuse)', () => {
  it('剪除终结工具的 toolCall + 对应 toolResult;保留探索工具与文本', () => {
    const msgs = [
      user('map task'),
      asst([text('here is my plan'), toolCall('submit_plan', 'tc1')]),
      toolResult('submit_plan', 'tc1'),
      asst([toolCall('read_file', 'tc2')]),
      toolResult('read_file', 'tc2'),
    ];
    const out = pruneFinalizationCalls(msgs, 'submit_plan');
    expect(roles(out)).toEqual(['user', 'assistant', 'assistant', 'toolResult']);
    expect(contentTypes(out[1]!)).toEqual(['text']);
    expect(contentTypes(out[2]!)).toEqual(['toolCall']);
  });

  it('assistant 只含被剪终结调用 → 整条丢弃', () => {
    const msgs = [user('t'), asst([toolCall('submit_findings', 'x')]), toolResult('submit_findings', 'x')];
    const out = pruneFinalizationCalls(msgs, 'submit_findings');
    expect(roles(out)).toEqual(['user']);
  });

  it('多终结名(map+dig 合并 session 后 fork)一并剪除', () => {
    const msgs = [
      user('t'),
      asst([toolCall('submit_plan', 'a')]),
      toolResult('submit_plan', 'a'),
      asst([text('dig'), toolCall('submit_findings', 'b')]),
      toolResult('submit_findings', 'b'),
    ];
    const out = pruneFinalizationCalls(msgs, ['submit_plan', 'submit_findings']);
    expect(roles(out)).toEqual(['user', 'assistant']);
    expect(contentTypes(out[1]!)).toEqual(['text']);
  });

  it('空名集合 → 原样返回(浅拷贝,不改原数组)', () => {
    const msgs = [user('t'), asst([toolCall('submit_plan', 'a')])];
    const out = pruneFinalizationCalls(msgs, []);
    expect(out).toHaveLength(2);
    expect(out).not.toBe(msgs);
  });

  it('按 toolCallId 剪对应 toolResult(即便其 toolName 缺失/不同)', () => {
    const msgs = [
      user('t'),
      asst([toolCall('submit_plan', 'id9')]),
      { role: 'toolResult', toolCallId: 'id9', content: [], isError: false, timestamp: 0 } as unknown as AgentMessage,
    ];
    const out = pruneFinalizationCalls(msgs, 'submit_plan');
    expect(roles(out)).toEqual(['user']);
  });
});
