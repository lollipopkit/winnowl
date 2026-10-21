import type { KnowledgeToolEntry } from '@reviewbot/agent-pi';

/** Rules longer than this are listed by their opening and read in full with `knowledge_read`. */
export const RULE_INLINE_MAX = 300;
const OPENING_MAX = 200;

/** Long rules become their opening plus a read pointer; the full text is pushed to `entries`. */
export function ruleLine(rule: { id: string; content: string }, entries: KnowledgeToolEntry[]): string {
  if (rule.content.length <= RULE_INLINE_MAX) return `- ${rule.content}`;
  const opening = openingOf(rule.content);
  entries.push({ id: rule.id, kind: 'rule', title: opening, body: rule.content });
  return `- ${opening} [read: knowledge_read ${rule.id}]`;
}

export function openingOf(text: string): string {
  const firstLine = text.trim().split('\n')[0]!.trim();
  // Latin sentences end in punctuation + space; CJK full-width punctuation needs no space.
  const sentence = /^(.+?(?:[.!?](?=\s|$)|[。!?]))/u.exec(firstLine)?.[1] ?? firstLine;
  return sentence.length <= OPENING_MAX ? sentence : `${sentence.slice(0, OPENING_MAX).trimEnd()}…`;
}
