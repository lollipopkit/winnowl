import { describe, expect, it } from 'vitest';
import { classifyStreamFailure, createRequestAbort, DEFAULT_REQUEST_TIMEOUT_MS, resolveRequestTimeoutMs } from '../src/index.js';

describe('resolveRequestTimeoutMs', () => {
  it('显式 > env > 默认', () => {
    expect(resolveRequestTimeoutMs(1234, { LLM_REQUEST_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)).toBe(1234);
    expect(resolveRequestTimeoutMs(undefined, { LLM_REQUEST_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)).toBe(5000);
    expect(resolveRequestTimeoutMs(undefined, {} as NodeJS.ProcessEnv)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('env 非法值回退默认(不因误配变成 NaN 而永不超时)', () => {
    expect(resolveRequestTimeoutMs(undefined, { LLM_REQUEST_TIMEOUT_MS: 'abc' } as NodeJS.ProcessEnv)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('显式 0 = 禁用超时(留给刻意要无限等的场景)', () => {
    expect(resolveRequestTimeoutMs(0, {} as NodeJS.ProcessEnv)).toBe(0);
  });
});

describe('createRequestAbort(超时看门狗)', () => {
  it('超时后 signal 中止,且原因文本能被归类为可重试的 timeout', async () => {
    const { signal } = createRequestAbort(20);
    expect(signal!.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(signal!.aborted).toBe(true);
    const reason = signal!.reason as Error;
    expect(reason.message).toContain('LLM 请求超时');
    // Must classify as timeout (retryable), not unknown.
    expect(classifyStreamFailure(reason.message)).toBe('timeout');
  });

  it('dispose 后不再中止(正常完成的调用不该留下会开火的定时器)', async () => {
    const { signal, dispose } = createRequestAbort(20);
    dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(signal!.aborted).toBe(false);
  });

  it('转发调用方 signal(取消语义不丢)', () => {
    const caller = new AbortController();
    const { signal } = createRequestAbort(10_000, caller.signal);
    expect(signal!.aborted).toBe(false);
    caller.abort(new Error('caller cancelled'));
    expect(signal!.aborted).toBe(true);
    expect((signal!.reason as Error).message).toBe('caller cancelled');
  });

  it('调用方 signal 已中止 → 立即中止', () => {
    const caller = AbortController.prototype.constructor === AbortController ? new AbortController() : new AbortController();
    caller.abort(new Error('already'));
    const { signal } = createRequestAbort(10_000, caller.signal);
    expect(signal!.aborted).toBe(true);
  });

  it('timeoutMs<=0 → 不装看门狗,原样透传调用方 signal', () => {
    const caller = new AbortController();
    expect(createRequestAbort(0, caller.signal).signal).toBe(caller.signal);
    expect(createRequestAbort(0).signal).toBeUndefined();
  });
});
