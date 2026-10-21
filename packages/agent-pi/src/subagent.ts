import { Type, type Model, type Static, type TSchema } from '@earendil-works/pi-ai';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { runAgentInvocation, type CollectorDef, type FinalizationDef } from './runner.js';
import { toolTextResult } from './tools.js';
import type { AgentBudget, InvocationStatus, InvocationUsage } from './types.js';

/**
 * Tool that lets the model split exploration into concurrent child invocations. Output streaming is serial per
 * invocation, so parallel children cut wall-clock time. Children start with a fresh context and return only
 * their conclusion. They never get this tool, so nesting is limited to one level.
 */
export interface SubagentToolOptions<T extends TSchema> {
  name: string;
  description: string;
  label: string;
  systemPrompt: string;
  model: Model<string>;
  fallbackModels?: Model<string>[];
  streamFn: StreamFn;
  /** Must not include this tool (unbounded recursion). */
  readTools: AgentTool[];
  /** Children submit directly so the parent does not re-output the same content. */
  collectors?: CollectorDef<TSchema>[];
  finalization: FinalizationDef<T>;
  /** Per child, separate from the parent's budget. */
  budget: AgentBudget;
  maxConcurrency: number;
  /** Max children per call. */
  maxTasks: number;
  /** Stage deadline; pass it or children outlive their stage. */
  signal?: AbortSignal;
  /** Reports child usage to the parent so the cost gate sees it. */
  onUsage?: (u: InvocationUsage) => void;
  onCollected?: (name: string, payloads: unknown[]) => void;
  renderResult: (r: { goal: string; status: InvocationStatus; finalization?: Static<T> }) => string;
}

/** Order-preserving bounded concurrency; local copy because agent-pi must not depend on review-engine. */
async function boundedMap<A, B>(items: readonly A[], limit: number, fn: (a: A, i: number) => Promise<B>): Promise<B[]> {
  const out = new Array<B>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export function buildSubagentTool<T extends TSchema>(opts: SubagentToolOptions<T>): AgentTool {
  const TASKS = Type.Object({
    tasks: Type.Array(
      Type.Object({
        goal: Type.String({ description: 'One self-contained question to answer. State it so someone who has not seen this conversation can act on it.' }),
        files: Type.Optional(Type.Array(Type.String(), { description: 'Paths worth starting from, if known.' })),
      }),
      { minItems: 1, maxItems: opts.maxTasks, description: `Up to ${opts.maxTasks} independent questions, investigated at the same time.` },
    ),
  });

  return {
    name: opts.name,
    description: opts.description,
    label: opts.label,
    parameters: TASKS,
    execute: async (_id, params) => {
      const { tasks } = params as Static<typeof TASKS>;
      // Truncate instead of failing; the result text says so.
      const kept = tasks.slice(0, opts.maxTasks);
      const dropped = tasks.length - kept.length;

      const results = await boundedMap(kept, opts.maxConcurrency, async (t) => {
        const hint = t.files && t.files.length > 0 ? `\n\nStart from: ${t.files.join(', ')}` : '';
        const r = await runAgentInvocation({
          systemPrompt: opts.systemPrompt,
          task: `${t.goal}${hint}`,
          model: opts.model,
          ...(opts.fallbackModels ? { fallbackModels: opts.fallbackModels } : {}),
          streamFn: opts.streamFn,
          readTools: opts.readTools,
          ...(opts.collectors ? { collectors: opts.collectors } : {}),
          finalization: opts.finalization,
          budget: opts.budget,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (r.usage) opts.onUsage?.(r.usage);
        for (const [name, payloads] of Object.entries(r.collected)) {
          if (payloads.length > 0) opts.onCollected?.(name, payloads);
        }
        return opts.renderResult({ goal: t.goal, status: r.status, ...(r.finalization !== undefined ? { finalization: r.finalization } : {}) });
      });

      const body = results.join('\n\n');
      // Must be in the text, not just details: the model decides from the text.
      const note = dropped > 0 ? `\n\n(${dropped} more were not run: at most ${opts.maxTasks} at a time.)` : '';
      return toolTextResult(`${body}${note}`, { tasks: kept.length, dropped });
    },
  };
}
