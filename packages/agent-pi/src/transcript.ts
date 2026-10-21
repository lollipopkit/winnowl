import type { AgentMessage } from '@earendil-works/pi-agent-core';

type AssistantMsg = Extract<AgentMessage, { role: 'assistant' }>;
type ToolResultMsg = Extract<AgentMessage, { role: 'toolResult' }>;
type ContentItem = AssistantMsg['content'][number];
type ToolCallItem = Extract<ContentItem, { type: 'toolCall' }>;

const isAssistant = (m: AgentMessage): m is AssistantMsg => (m as { role?: string }).role === 'assistant';
const isToolResult = (m: AgentMessage): m is ToolResultMsg => (m as { role?: string }).role === 'toolResult';
const isToolCall = (c: ContentItem): c is ToolCallItem => (c as { type?: string }).type === 'toolCall';

/**
 * Removes calls to the named finalization tools and their results before a transcript seeds another stage,
 * whose toolset lacks those tools (dangling tool calls). System messages are removed too: pi keeps the prompt
 * and tool declarations there, and a seeded system message would stop the receiving agent declaring its own.
 */
export function pruneFinalizationCalls(messages: AgentMessage[], names: string | Iterable<string>): AgentMessage[] {
  const nameSet = new Set<string>(typeof names === 'string' ? [names] : names);

  // By id too, in case a toolResult lacks toolName.
  const removedIds = new Set<string>();
  for (const m of messages) {
    if (!isAssistant(m)) continue;
    for (const c of m.content) if (isToolCall(c) && nameSet.has(c.name)) removedIds.add(c.id);
  }

  const out: AgentMessage[] = [];
  for (const m of messages) {
    if ((m as { role?: string }).role === 'system') continue;
    if (isToolResult(m) && (nameSet.has(m.toolName) || removedIds.has(m.toolCallId))) continue;
    if (isAssistant(m)) {
      const content = m.content.filter((c) => !(isToolCall(c) && nameSet.has(c.name)));
      if (content.length === 0) continue;
      out.push(content.length === m.content.length ? m : { ...m, content });
      continue;
    }
    out.push(m);
  }
  return out;
}
