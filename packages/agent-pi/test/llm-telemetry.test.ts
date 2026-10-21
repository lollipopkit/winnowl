import { describe, expect, it } from 'vitest';
import { metricsText } from '@reviewbot/telemetry';
import { observeLlmCall } from '../src/model-source.js';

// Every LLM call must be recorded in the metrics with its outcome and failure kind.
describe('LLM 调用埋点(§可观测性)', () => {
  it('网关故障 → outcome=error 且带上归类(可直接用来告警)', async () => {
    const call = observeLlmCall('openai', 'test-model-gateway');
    call.settle({ stopReason: 'error', errorMessage: 'stream error: event: error' });
    const text = await metricsText();
    expect(text).toContain('model="test-model-gateway",outcome="error",failure_kind="gateway_transport"');
  });

  it('护栏拒绝与网关故障分得开(一个重试无用,一个该等着重试)', async () => {
    observeLlmCall('openai', 'test-model-filter').settle({
      stopReason: 'error',
      errorMessage: 'request blocked by content policy',
    });
    const text = await metricsText();
    expect(text).toContain('model="test-model-filter",outcome="error",failure_kind="content_filter"');
  });

  it('正常完成 → outcome=ok,failure_kind=none(而非空标签)', async () => {
    observeLlmCall('openai', 'test-model-ok').settle({
      stopReason: 'stop',
      usage: { input: 100, output: 20, totalTokens: 120 },
    });
    const text = await metricsText();
    expect(text).toContain('model="test-model-ok",outcome="ok",failure_kind="none"');
  });

  it('重复 settle 只记一次(流的 result() 与异常路径都会走到,不能重复计数)', async () => {
    const call = observeLlmCall('openai', 'test-model-once');
    call.settle({ stopReason: 'stop' });
    call.settle({ stopReason: 'error', errorMessage: 'boom' });
    const text = await metricsText();
    const line = text
      .split('\n')
      .find((l) => l.startsWith('winnowl_llm_calls_total{') && l.includes('test-model-once'));
    expect(line).toContain('outcome="ok"');
    expect(line?.trim().endsWith(' 1')).toBe(true);
  });
});
