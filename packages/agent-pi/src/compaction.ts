import type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * Deterministic context compaction: replaces the oldest tool result bodies with a placeholder (the model can
 * re-call the tool). No LLM summaries, which would replace source text with paraphrase. Only toolResult bodies
 * change; the last `keepRecent` messages are untouched.
 *
 * Estimates from the original messages with `estimateTokens`, not provider usage: pi keeps the uncompacted
 * transcript in state, and usage reflects the compacted request. Recomputing from the original each turn
 * yields the same cut, keeping the prefix stable for the prompt cache.
 */
/** An image counted as this many characters, as pi's own estimate did. */
const ESTIMATED_IMAGE_CHARS = 4800;

function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content as { type?: string; text?: string }[]) {
    if (block.type === 'text' && block.text) chars += block.text.length;
    else if (block.type === 'image') chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** Conservative estimate (characters / 4), the heuristic pi-agent-core shipped before 1.0 removed it. */
export function estimateTokens(message: AgentMessage): number {
  const m = message as { role?: string; content?: unknown };
  if (m.role === 'assistant' && Array.isArray(m.content)) {
    let chars = 0;
    for (const block of m.content as { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }[]) {
      if (block.type === 'text') chars += block.text?.length ?? 0;
      else if (block.type === 'thinking') chars += block.thinking?.length ?? 0;
      else if (block.type === 'toolCall') chars += (block.name?.length ?? 0) + (JSON.stringify(block.arguments) ?? '').length;
    }
    return Math.ceil(chars / 4);
  }
  return Math.ceil(contentChars(m.content) / 4);
}

export interface CompactionPolicy {
  /** Start eliding above this fraction of the window. */
  triggerRatio: number;
  /** Elide until below this fraction. */
  targetRatio: number;
  keepRecent: number;
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  triggerRatio: 0.7,
  targetRatio: 0.6,
  keepRecent: 6,
};

type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>;

const isToolResult = (m: AgentMessage): m is ToolResultMessage =>
  (m as { role?: string }).role === 'toolResult';

const ELIDED_PREFIX = '[elided to save context:';

function textLength(m: ToolResultMessage): number {
  return m.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0);
}

function isElided(m: ToolResultMessage): boolean {
  const first = m.content[0];
  return first?.type === 'text' && first.text.startsWith(ELIDED_PREFIX);
}

function elide(m: ToolResultMessage): ToolResultMessage {
  return {
    ...m,
    content: [
      {
        type: 'text',
        text: `${ELIDED_PREFIX} ${m.toolName} output, ${textLength(m)} characters. Call the tool again if you still need it.]`,
      },
    ],
  };
}

export interface CompactionOutcome {
  messages: AgentMessage[];
  /** Newly elided tool results (0 = unchanged). */
  elided: number;
}

/** No-op when `contextWindow <= 0` (unknown window); overflow is then handled as `context_overflow`. */
export function compactMessages(
  messages: AgentMessage[],
  contextWindow: number,
  policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY,
): CompactionOutcome {
  if (contextWindow <= 0) return { messages, elided: 0 };
  let tokens = messages.reduce((n, m) => n + estimateTokens(m), 0);
  if (tokens <= contextWindow * policy.triggerRatio) return { messages, elided: 0 };

  const target = contextWindow * policy.targetRatio;
  const out = messages.slice();
  const protectedFrom = Math.max(0, out.length - policy.keepRecent);
  let elided = 0;
  for (let i = 0; i < protectedFrom && tokens > target; i += 1) {
    const m = out[i]!;
    if (!isToolResult(m) || isElided(m)) continue;
    const replacement = elide(m);
    tokens -= estimateTokens(m) - estimateTokens(replacement);
    out[i] = replacement;
    elided += 1;
  }
  return { messages: elided > 0 ? out : messages, elided };
}
