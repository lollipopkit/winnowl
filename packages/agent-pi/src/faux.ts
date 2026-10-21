import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  type Model,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

/** Test agent on the pi-ai faux provider, so downstream tests need not depend on pi directly. */
export interface FauxAgent {
  model: Model<string>;
  streamFn: StreamFn;
  setResponses: (steps: unknown[]) => void;
  appendResponses: (steps: unknown[]) => void;
  toolCall: typeof fauxToolCall;
  assistant: typeof fauxAssistantMessage;
}

export function createFauxAgent(): FauxAgent {
  const core = createFauxCore({ provider: 'faux', api: 'faux-api', models: [{ id: 'faux-1' }] });
  return {
    model: core.getModel() as Model<string>,
    streamFn: core.streamSimple as unknown as StreamFn,
    setResponses: (steps) => core.setResponses(steps as never),
    appendResponses: (steps) => core.appendResponses(steps as never),
    toolCall: fauxToolCall,
    assistant: fauxAssistantMessage,
  };
}

/** Each invocation declares exactly one of these, used as the routing key. */
const STAGE_FINALIZATIONS = ['submit_plan', 'complete_section', 'submit_summary', 'submit_assessment', 'confirm_assessment', 'submit_resolution'] as const;
type StageFinalization = (typeof STAGE_FINALIZATIONS)[number];

export interface RoutingFauxAgent {
  model: Model<string>;
  streamFn: StreamFn;
  /** Per-stage response queues, consumed in order within a stage and independent of global scheduling. */
  setStageResponses: (byFinalization: Partial<Record<StageFinalization, unknown[]>>) => void;
  /** Messages received by each invocation routed to the stage, in order; used to test context reuse. */
  messagesFor: (finalization: StageFinalization) => unknown[][];
  toolCall: typeof fauxToolCall;
  assistant: typeof fauxAssistantMessage;
}

/** Faux agent routing by finalization tool to per-stage queues; deterministic under concurrent invocations. */
export function createRoutingFauxAgent(): RoutingFauxAgent {
  const cores = new Map<StageFinalization, ReturnType<typeof createFauxCore>>();
  for (const f of STAGE_FINALIZATIONS) {
    cores.set(f, createFauxCore({ provider: 'faux', api: 'faux-api', models: [{ id: 'faux-1' }] }));
  }
  const routeKey = (messages: Message[]): StageFinalization => {
    const names = new Set(getCurrentTools(messages).map((t) => t.name));
    for (const f of STAGE_FINALIZATIONS) if (names.has(f)) return f;
    throw new Error(`routing-faux: 当前工具无已知 finalization(有:${[...names].join(',') || '空'})`);
  };
  const seen = new Map<StageFinalization, unknown[][]>();
  const streamFn = ((model: unknown, context: unknown, options: unknown) => {
    const all = (context as { messages?: Message[] }).messages ?? [];
    const key = routeKey(all);
    const msgs = all.filter((m) => m.role !== 'system');
    const bucket = seen.get(key) ?? [];
    // Messages only grow within an invocation, so a shorter list marks a new invocation.
    const last = bucket[bucket.length - 1];
    if (!last || msgs.length <= (last as unknown[]).length) bucket.push([...msgs]);
    else bucket[bucket.length - 1] = [...msgs];
    seen.set(key, bucket);
    const core = cores.get(key)!;
    return (core.streamSimple as (...a: unknown[]) => unknown)(model, context, options);
  }) as unknown as StreamFn;
  return {
    model: cores.get('submit_plan')!.getModel() as Model<string>,
    streamFn,
    setStageResponses: (byFin) => {
      for (const [k, steps] of Object.entries(byFin)) {
        if (steps) cores.get(k as StageFinalization)!.setResponses(steps as never);
      }
    },
    messagesFor: (f) => seen.get(f) ?? [],
    toolCall: fauxToolCall,
    assistant: fauxAssistantMessage,
  };
}

/** System prompt a model call received; pi keeps it in transcript system messages, not on the context. */
export function systemPromptOf(context: unknown): string {
  return getCurrentSystemPrompt((context as { messages?: Message[] }).messages ?? []);
}
