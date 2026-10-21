import { runAgentInvocation, Type, type AgentBudget, type Model, type Static, type StreamFn } from '@reviewbot/agent-pi';
import { matchesGlob, type RetrievalItem } from '@reviewbot/knowledge';

/**
 * Picks which learnings to inject. A file-glob hit is a ranking signal, not a gate. Few candidates are
 * all injected without an LLM call; mandatory and selector-less rules are always kept.
 */

const SELECT_KNOWLEDGE_SCHEMA = Type.Object({
  selectedIds: Type.Array(Type.String(), {
    description: 'IDs (from the candidate list) of the learnings that apply to THIS change. Omit ones that are irrelevant to the changed code.',
  }),
});
type SelectPayload = Static<typeof SELECT_KNOWLEDGE_SCHEMA>;

const SELECT_SYSTEM =
  'You pick which project learnings (accumulated review preferences/rules) are relevant to a specific code change. ' +
  'Given a change summary and a numbered list of candidate learnings, select ONLY the ones that plausibly apply to the changed code. ' +
  'Be inclusive when unsure but drop clearly-unrelated ones. Return their ids via submit.';

export interface SelectKnowledgeDeps {
  model: Model<string>;
  streamFn: StreamFn;
  budget: AgentBudget;
  changedPaths: readonly string[];
  changeSummary?: string;
  /** At or below this many candidates, inject all without an LLM call (default 12). */
  injectAllThreshold?: number;
  /** Max candidates sent to the LLM; extras are dropped by file match then specificity (default 60). */
  selectCap?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
  now?: number;
}

export interface SelectKnowledgeResult {
  /** In input order. */
  items: RetrievalItem[];
  usedIds: string[];
  llmSelected: boolean;
}

function isFileMatched(item: RetrievalItem, paths: readonly string[]): boolean {
  return item.selector !== undefined && paths.some((p) => matchesGlob(item.selector!, p));
}

function isAlwaysKeep(item: RetrievalItem): boolean {
  return item.mandatory === true || item.selector === undefined;
}

export async function selectKnowledge(candidates: readonly RetrievalItem[], deps: SelectKnowledgeDeps): Promise<SelectKnowledgeResult> {
  const now = deps.now ?? Date.now();
  const injectAllThreshold = deps.injectAllThreshold ?? 12;
  const selectCap = deps.selectCap ?? 60;
  const log = deps.log ?? (() => undefined);

  const live = candidates.filter((c) => c.expiresAt === undefined || c.expiresAt > now);

  if (live.length <= injectAllThreshold) {
    return { items: [...live], usedIds: live.map((i) => i.id), llmSelected: false };
  }

  const alwaysKeep = live.filter(isAlwaysKeep);
  let selectable = live.filter((c) => !isAlwaysKeep(c));
  if (selectable.length === 0) {
    return { items: alwaysKeep, usedIds: alwaysKeep.map((i) => i.id), llmSelected: false };
  }

  const budget = selectCap - alwaysKeep.length;
  if (alwaysKeep.length + selectable.length > selectCap && budget > 0) {
    const ranked = [...selectable].sort((a, b) => {
      const f = Number(isFileMatched(b, deps.changedPaths)) - Number(isFileMatched(a, deps.changedPaths));
      if (f !== 0) return f;
      return (b.specificity ?? 0) - (a.specificity ?? 0);
    });
    const dropped = ranked.length - budget;
    selectable = ranked.slice(0, budget);
    if (dropped > 0) log('knowledge candidates truncated before selection', { total: live.length, cap: selectCap, dropped });
  }

  const index = selectable
    .map((c, i) => `[${i + 1}] id=${c.id}${isFileMatched(c, deps.changedPaths) ? ' (touches changed file)' : ''}\n${c.content.slice(0, 500)}`)
    .join('\n\n');
  const task =
    `Change summary: ${deps.changeSummary ?? '(none)'}\n` +
    `Changed files: ${deps.changedPaths.slice(0, 50).join(', ') || '(none)'}\n\n` +
    `Candidate learnings:\n${index}\n\n` +
    'Select the ids that apply to this change.';

  let selected: RetrievalItem[];
  try {
    const result = await runAgentInvocation({
      systemPrompt: SELECT_SYSTEM,
      task,
      model: deps.model,
      streamFn: deps.streamFn,
      readTools: [],
      finalization: { name: 'select_knowledge', description: 'Submit the applicable learning ids.', label: 'Select knowledge', schema: SELECT_KNOWLEDGE_SCHEMA },
      budget: deps.budget,
    });
    if (result.status === 'complete' && result.finalization) {
      const picked = new Set((result.finalization as SelectPayload).selectedIds);
      selected = selectable.filter((c) => picked.has(c.id));
    } else {
      log('knowledge selection incomplete, falling back to file-matched', { status: result.status });
      selected = selectable.filter((c) => isFileMatched(c, deps.changedPaths));
    }
  } catch (err) {
    log('knowledge selection failed, falling back to file-matched', { error: (err as Error)?.message });
    selected = selectable.filter((c) => isFileMatched(c, deps.changedPaths));
  }

  const keepIds = new Set([...alwaysKeep, ...selected].map((i) => i.id));
  const items = live.filter((i) => keepIds.has(i.id));
  return { items, usedIds: items.map((i) => i.id), llmSelected: true };
}
