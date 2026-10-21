import { describe, expect, it } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
  type Model,
} from '@earendil-works/pi-ai';
import { buildSecurityPreamble, buildSourceTools, resolveModel, runAgentInvocation, systemPromptOf, type SourceProvider } from '../src/index.js';

const CANDIDATE_SCHEMA = Type.Object({ claim: Type.String(), severity: Type.String() });

function makeSource(): { source: SourceProvider; searchCalls: () => number } {
  let searchCalls = 0;
  const source: SourceProvider = {
    listChangedFiles: async () => [{ path: 'a.ts', status: 'modified' }],
    readFile: async (p) => (p === 'a.ts' ? 'line1\nline2\n' : null),
    searchCode: async () => {
      searchCalls += 1;
      return [{ path: 'a.ts', line: 1, text: 'line1' }];
    },
  };
  return { source, searchCalls: () => searchCalls };
}

function faux() {
  const core = createFauxCore({ provider: 'faux', api: 'faux-api', models: [{ id: 'faux-1' }] });
  return {
    model: core.getModel() as Model<string>,
    streamFn: core.streamSimple as unknown as StreamFn,
    setResponses: core.setResponses,
  };
}

const budget = { maxTurns: 8, maxToolCalls: 16 };
const finalization = {
  name: 'submit_finding',
  description: 'Submit a candidate finding.',
  label: 'Submit candidate',
  schema: CANDIDATE_SCHEMA,
};

describe('runAgentInvocation', () => {
  // A seed starting with a system message stops the next agent from declaring its own prompt and tools.
  it('用上一次的 transcript 作种子 → 下一次仍是自己的 system prompt 与终结工具', async () => {
    const { source } = makeSource();
    const first = faux();
    first.setResponses([fauxAssistantMessage(fauxToolCall('submit_finding', { claim: 'x', severity: 'low' }))]);
    const explored = await runAgentInvocation({
      systemPrompt: 'FIRST-STAGE',
      task: 'Explore',
      model: first.model,
      streamFn: first.streamFn,
      readTools: buildSourceTools(source),
      finalization,
      budget,
    });
    expect(explored.transcript?.some((m) => (m as { role: string }).role === 'system')).toBe(false);

    const second = faux();
    second.setResponses([fauxAssistantMessage(fauxToolCall('submit_verdict', { claim: 'y', severity: 'high' }))]);
    let sys = '';
    const capturing = ((model: unknown, context: unknown, options: unknown) => {
      sys = systemPromptOf(context);
      return (second.streamFn as (...a: unknown[]) => unknown)(model, context, options);
    }) as unknown as StreamFn;
    const verified = await runAgentInvocation({
      systemPrompt: 'SECOND-STAGE',
      task: 'Verify',
      model: second.model,
      streamFn: capturing,
      readTools: buildSourceTools(source),
      finalization: { ...finalization, name: 'submit_verdict' },
      budget,
      seedMessages: explored.transcript!,
    });
    expect(sys).toContain('SECOND-STAGE');
    expect(sys).not.toContain('FIRST-STAGE');
    expect(verified.status).toBe('complete');
    expect(verified.finalizationTool).toBe('submit_verdict');
  });

  it('读取源码后通过终结工具提交结构化 Candidate', async () => {
    const { source } = makeSource();
    const f = faux();
    f.setResponses([
      fauxAssistantMessage(fauxToolCall('read_source', { path: 'a.ts' })),
      fauxAssistantMessage(fauxToolCall('submit_finding', { claim: 'off-by-one', severity: 'high' })),
    ]);

    const result = await runAgentInvocation({
      systemPrompt: 'You are a reviewer.',
      task: 'Review a.ts',
      model: f.model,
      streamFn: f.streamFn,
      readTools: buildSourceTools(source),
      finalization,
      budget,
    });

    expect(result.status).toBe('complete');
    expect(result.finalization).toEqual({ claim: 'off-by-one', severity: 'high' });
    expect(result.finalizationTool).toBe('submit_finding');
    expect(result.toolCalls).toBe(2);
    expect(result.evidence.map((e) => e.tool)).toEqual(['read_source', 'submit_finding']);
  });

  it('组装 system prompt:前置在前,阶段提示在后;两次 invocation 逐字相同(prompt cache 可命中)', async () => {
    const { source } = makeSource();
    const capture = async (): Promise<string> => {
      const f = faux();
      f.setResponses([fauxAssistantMessage(fauxToolCall('submit_finding', { claim: 'x', severity: 'low' }))]);
      let sysPrompt = '';
      const capturingStreamFn = ((model: unknown, context: unknown, options: unknown) => {
        sysPrompt = systemPromptOf(context);
        return (f.streamFn as (...a: unknown[]) => unknown)(model, context, options);
      }) as unknown as StreamFn;
      await runAgentInvocation({
        systemPrompt: 'STAGE-PROMPT-SENTINEL',
        task: 'Review',
        model: f.model,
        streamFn: capturingStreamFn,
        readTools: buildSourceTools(source),
        finalization,
        budget,
      });
      return sysPrompt;
    };

    const sysPrompt = await capture();
    expect(sysPrompt.indexOf('[SECURITY')).toBe(0);
    expect(sysPrompt.trimEnd().endsWith('STAGE-PROMPT-SENTINEL')).toBe(true);
    expect(await capture()).toBe(sysPrompt);
  });

  it('停下没交卷 → 提醒一次,同一段对话里交卷', async () => {
    const { source } = makeSource();
    const f = faux();
    f.setResponses([
      fauxAssistantMessage('The code looks fine to me.'),
      fauxAssistantMessage(fauxToolCall('submit_finding', { claim: 'x', severity: 'low' })),
    ]);
    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: f.model,
      streamFn: f.streamFn,
      readTools: buildSourceTools(source),
      finalization,
      budget,
    });
    expect(result.status).toBe('complete');
  });

  it('未调用终结工具 → incomplete(不假设无问题,§15.7)', async () => {
    const { source } = makeSource();
    const f = faux();
    // The second reply answers the nudge, still without calling the tool.
    f.setResponses([fauxAssistantMessage('I looked but found nothing to report.'), fauxAssistantMessage('Nothing to report.')]);

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: f.model,
      streamFn: f.streamFn,
      readTools: buildSourceTools(source),
      finalization,
      budget,
    });

    expect(result.status).toBe('incomplete');
    expect(result.incompleteReason).toBe('no finalization tool called');
  });

  // A stage deadline ends as incomplete with collected items kept, not as an error.
  it('外部 signal abort → incomplete(deadline),不是 error', async () => {
    const { source } = makeSource();
    const f = faux();
    f.setResponses(
      Array.from({ length: 20 }, () => fauxAssistantMessage(fauxToolCall('read_source', { path: 'a.ts' }))),
    );
    // Abort during a tool call instead of relying on setTimeout timing.
    const controller = new AbortController();
    const abortingSource = {
      ...source,
      readFile: async (p: string) => {
        controller.abort();
        return source.readFile(p);
      },
    };

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: f.model,
      streamFn: f.streamFn,
      readTools: buildSourceTools(abortingSource),
      finalization,
      budget: { maxTurns: 100, maxToolCalls: 200 },
      signal: controller.signal,
    });

    expect(result.status).toBe('incomplete');
    expect(result.incompleteReason).toBe('deadline exceeded');
  });

  it('已 abort 的 signal → 立刻 incomplete(不发一次请求)', async () => {
    const { source } = makeSource();
    const f = faux();
    f.setResponses([fauxAssistantMessage(fauxToolCall('submit_finding', { claim: 'x', severity: 'low' }))]);

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: f.model,
      streamFn: f.streamFn,
      readTools: buildSourceTools(source),
      finalization,
      budget,
      signal: AbortSignal.abort(),
    });
    expect(result.status).toBe('incomplete');
    expect(result.incompleteReason).toBe('deadline exceeded');
  });

  it('超过 turn 预算 → incomplete(turn budget)', async () => {
    const { source } = makeSource();
    const f = faux();
    f.setResponses(
      Array.from({ length: 6 }, () => fauxAssistantMessage(fauxToolCall('read_source', { path: 'a.ts' }))),
    );

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: f.model,
      streamFn: f.streamFn,
      readTools: buildSourceTools(source),
      finalization,
      budget: { maxTurns: 2, maxToolCalls: 16 },
    });

    expect(result.status).toBe('incomplete');
    expect(result.incompleteReason).toBe('turn budget exhausted');
    // Abort fires from turn_end and may take effect one turn late.
    expect(result.turns).toBeGreaterThanOrEqual(2);
    expect(result.turns).toBeLessThanOrEqual(3);
  });

  it('可重试的流失败 → 自动重试,成功即 complete(attempts 记实际次数)', async () => {
    const { source } = makeSource();
    const f = faux();
    f.setResponses([fauxAssistantMessage(fauxToolCall('submit_finding', { claim: 'off-by-one', severity: 'high' }))]);
    let calls = 0;
    const flaky = ((...args: unknown[]) => {
      calls += 1;
      if (calls === 1) throw new Error('stream error: event: error');
      return (f.streamFn as unknown as (...a: unknown[]) => unknown)(...args);
    }) as unknown as StreamFn;

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: f.model,
      streamFn: flaky,
      readTools: buildSourceTools(source),
      finalization,
      budget,
    });

    expect(result.status).toBe('complete');
    expect(result.finalization).toEqual({ claim: 'off-by-one', severity: 'high' });
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('护栏拒绝不重试(换说法才有用,重试只是再被拒一次)', async () => {
    const { source } = makeSource();
    const f = faux();
    let calls = 0;
    const blocked = (() => {
      calls += 1;
      throw new Error('request blocked by content policy');
    }) as unknown as StreamFn;

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: f.model,
      streamFn: blocked,
      readTools: buildSourceTools(source),
      finalization,
      budget,
    });

    expect(result.status).toBe('error');
    expect(result.failureKind).toBe('content_filter');
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('重试用尽仍失败 → error,attempts = maxAttempts', async () => {
    const { source } = makeSource();
    const f = faux();
    let calls = 0;
    const alwaysDown = (() => {
      calls += 1;
      throw new Error('fetch failed: ECONNRESET');
    }) as unknown as StreamFn;

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: f.model,
      streamFn: alwaysDown,
      readTools: buildSourceTools(source),
      finalization,
      budget,
      maxAttempts: 2,
    });

    expect(result.status).toBe('error');
    expect(result.failureKind).toBe('gateway_transport');
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  // Model fallback after retries are exhausted, except for key-scoped rate limits.
  it('主模型持续失败(非限流)→ 换同档备选模型,成功即 complete', async () => {
    const { source } = makeSource();
    const f = faux();
    f.setResponses([fauxAssistantMessage(fauxToolCall('submit_finding', { claim: 'off-by-one', severity: 'high' }))]);
    const seen: string[] = [];
    const perModel = ((m: unknown, ...rest: unknown[]) => {
      const id = (m as { id: string }).id;
      seen.push(id);
      if (id === 'primary') throw new Error('502 Bad Gateway');
      return (f.streamFn as unknown as (...a: unknown[]) => unknown)(m, ...rest);
    }) as unknown as StreamFn;

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: { ...f.model, id: 'primary' },
      fallbackModels: [{ ...f.model, id: 'backup' }],
      streamFn: perModel,
      readTools: buildSourceTools(source),
      finalization,
      budget,
      maxAttempts: 2,
    });

    expect(result.status).toBe('complete');
    expect(result.modelId).toBe('backup');
    expect(seen.filter((id) => id === 'primary')).toHaveLength(2);
    expect(result.attempts).toBe(3);
  });

  it('限流 → 只重试,绝不换模型(配额挂在 key 上,换了也是同一堵墙)', async () => {
    const { source } = makeSource();
    const f = faux();
    const seen: string[] = [];
    const limited = ((m: unknown) => {
      seen.push((m as { id: string }).id);
      throw new Error('OpenAI API error (429): concurrency limit (7 concurrent requests) exceeded for this API key');
    }) as unknown as StreamFn;

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: { ...f.model, id: 'primary' },
      fallbackModels: [{ ...f.model, id: 'backup' }],
      streamFn: limited,
      readTools: buildSourceTools(source),
      finalization,
      budget,
      maxAttempts: 2,
    });

    expect(result.status).toBe('error');
    expect(result.failureKind).toBe('rate_limit');
    expect(seen).toEqual(['primary', 'primary']);
    expect(result.modelId).toBe('primary');
  });

  it('护栏拒绝 → 不重试同一个模型,但换下一个模型试(护栏是模型自己的)', async () => {
    const { source } = makeSource();
    const f = faux();
    f.setResponses([fauxAssistantMessage(fauxToolCall('submit_finding', { claim: 'x', severity: 'low' }))]);
    const seen: string[] = [];
    const guarded = ((m: unknown, ...rest: unknown[]) => {
      const id = (m as { id: string }).id;
      seen.push(id);
      if (id === 'primary') throw new Error('blocked by content policy');
      return (f.streamFn as unknown as (...a: unknown[]) => unknown)(m, ...rest);
    }) as unknown as StreamFn;

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: { ...f.model, id: 'primary' },
      fallbackModels: [{ ...f.model, id: 'backup' }],
      streamFn: guarded,
      readTools: buildSourceTools(source),
      finalization,
      budget,
    });

    expect(result.status).toBe('complete');
    expect(seen).toEqual(['primary', 'backup']);
    expect(result.modelId).toBe('backup');
  });

  it('工具策略拦截不允许的工具(§15.6)', async () => {
    const { source, searchCalls } = makeSource();
    const f = faux();
    f.setResponses([
      fauxAssistantMessage(fauxToolCall('search_code', { query: 'secret' })),
      fauxAssistantMessage(fauxToolCall('submit_finding', { claim: 'c', severity: 'low' })),
    ]);

    const result = await runAgentInvocation({
      systemPrompt: 'reviewer',
      task: 'Review',
      model: f.model,
      streamFn: f.streamFn,
      readTools: buildSourceTools(source),
      finalization,
      budget,
      toolPolicy: { allowed: new Set(['read_source', 'read_range', 'list_changed_files']) },
    });

    expect(result.status).toBe('complete'); // finalization is always allowed
    expect(searchCalls()).toBe(0);
  });

  it('resolveModel 对未知模型抛错(§15.3)', () => {
    expect(() => resolveModel({ provider: 'nonexistent-provider', modelId: 'nope' })).toThrow();
  });

  it('buildSecurityPreamble 含抗注入', () => {
    const p = buildSecurityPreamble();
    expect(p).toMatch(/UNTRUSTED DATA/);
    expect(p).toMatch(/highest priority|overrides/i);
  });
});
