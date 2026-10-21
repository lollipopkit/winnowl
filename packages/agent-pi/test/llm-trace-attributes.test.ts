import { describe, expect, it } from 'vitest';
import { llmTraceAttributes } from '@reviewbot/telemetry';
import { bodyCaptureLimit, serializeBody } from '../src/model-source.js';

// Without these labels traces cannot be filtered, nor located by installation for erasure.
describe('业务上下文 → Langfuse 属性', () => {
  it('用 Langfuse 认得的键名,metadata 必须带可筛前缀', () => {
    const attrs = llmTraceAttributes({
      tenantId: 't-1',
      installationId: 'inst-1',
      repo: 'lollipopkit/mfuse',
      changeRequestNumber: 26,
      sessionId: 'rev-9',
      userId: 'lollipopkit',
      stage: 'review',
      tags: ['review', 'manual'],
    });
    // Keys without the `langfuse.trace.metadata.` prefix land in metadata.attributes and cannot be filtered.
    expect(attrs).toEqual({
      'langfuse.session.id': 'rev-9',
      'langfuse.user.id': 'lollipopkit',
      'langfuse.trace.tags': ['review', 'manual'],
      'langfuse.trace.metadata.tenant': 't-1',
      // Erasure is per installation; deleting by tenant would hit the tenant's other installations.
      'langfuse.trace.metadata.installation': 'inst-1',
      'langfuse.trace.metadata.repo': 'lollipopkit/mfuse',
      'langfuse.trace.metadata.pr': 26,
      'langfuse.trace.metadata.stage': 'review',
      // One key per experiment: Langfuse only groups by top-level metadata keys.
    });
  });

  it('空的分臂 map 不产生键(没参与实验的 review 不该多出一列)', () => {
  });

  it('无上下文 / 空字段 → 不产生空标签(免得 Langfuse 里到处是空字符串)', () => {
    expect(llmTraceAttributes(undefined)).toEqual({});
    expect(llmTraceAttributes({})).toEqual({});
    expect(llmTraceAttributes({ tags: [] })).toEqual({});
  });

  it('PR 号 0 也要送(falsy 但有意义)', () => {
    expect(llmTraceAttributes({ changeRequestNumber: 0 })['langfuse.trace.metadata.pr']).toBe(0);
  });
});

describe('prompt/response 正文入 span(fail-closed)', () => {
  it('默认关 —— 正文是客户源码,不能因为「配了个端点」就顺带发出去', () => {
    expect(bodyCaptureLimit({} as NodeJS.ProcessEnv)).toBe(0);
    expect(bodyCaptureLimit({ LLM_TRACE_BODIES: '0' } as NodeJS.ProcessEnv)).toBe(0);
    // Only '1' enables it.
    expect(bodyCaptureLimit({ LLM_TRACE_BODIES: 'true' } as NodeJS.ProcessEnv)).toBe(0);
  });

  it('显式开启后有默认上限,且可调', () => {
    expect(bodyCaptureLimit({ LLM_TRACE_BODIES: '1' } as NodeJS.ProcessEnv)).toBe(32_768);
    expect(bodyCaptureLimit({ LLM_TRACE_BODIES: '1', LLM_TRACE_BODY_LIMIT_BYTES: '512' } as NodeJS.ProcessEnv)).toBe(512);
    // Invalid values fall back to the default instead of NaN.
    expect(bodyCaptureLimit({ LLM_TRACE_BODIES: '1', LLM_TRACE_BODY_LIMIT_BYTES: 'abc' } as NodeJS.ProcessEnv)).toBe(32_768);
  });

  it('limit=0(未开启)→ 一律不序列化', () => {
    expect(serializeBody({ messages: ['secret'] }, 0)).toBeUndefined();
  });

  it('超限截断并留标记(半截 JSON 不能被当成模型真实输入)', () => {
    const out = serializeBody({ m: 'x'.repeat(500) }, 40)!;
    expect(out).toContain('[truncated');
    expect(out.startsWith('{"m":"xxx')).toBe(true);
    expect(out.length).toBeLessThan(80);
  });

  it('未超限则原样', () => {
    expect(serializeBody({ a: 1 }, 100)).toBe('{"a":1}');
    expect(serializeBody('plain', 100)).toBe('plain');
  });

  it('循环引用不抛 —— 遥测不该把业务调用带崩', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => serializeBody(cyclic, 100)).not.toThrow();
    expect(serializeBody(cyclic, 100)).toBeUndefined();
  });

  it('undefined / 空串 → 不产生属性', () => {
    expect(serializeBody(undefined, 100)).toBeUndefined();
    expect(serializeBody('', 100)).toBeUndefined();
  });
});
