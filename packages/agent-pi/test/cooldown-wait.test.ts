import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { shortCooldownWaitMs, withCooldownWait } from '../src/cooldown-wait.js';
import type { StreamFn } from '../src/index.js';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: 'luna', provider: 'openai', api: 'openai-completions' } as unknown as Model<string>;
const message = (extra: Record<string, unknown>) => ({ role: 'assistant', content: [], api: 'openai-completions', provider: 'openai', model: 'luna', usage, timestamp: 0, ...extra });
const cooldown = (seconds: number) =>
  `429 {"code":"model_cooldown","message":"All credentials for model luna are cooling down","model":"luna","reset_seconds":${seconds}}`;

type Step = { cooldown: number } | 'ok' | 'fail-after-text';

/** Answers each request with the next of `steps`; counts requests. */
function scripted(steps: Step[]): { streamFn: StreamFn; calls: () => number } {
  let n = 0;
  const streamFn = (() => {
    const step = steps[Math.min(n, steps.length - 1)]!;
    n += 1;
    const s = createAssistantMessageEventStream();
    queueMicrotask(() => {
      s.push({ type: 'start', partial: message({ stopReason: 'pending' }) } as never);
      if (typeof step === 'object') {
        s.push({ type: 'error', reason: 'error', error: message({ stopReason: 'error', errorMessage: cooldown(step.cooldown) }) } as never);
        return;
      }
      s.push({ type: 'text_start', contentIndex: 0, partial: message({ stopReason: 'pending' }) } as never);
      if (step === 'fail-after-text') {
        s.push({ type: 'error', reason: 'error', error: message({ stopReason: 'error', errorMessage: cooldown(5) }) } as never);
        return;
      }
      s.push({ type: 'done', reason: 'stop', message: message({ stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] }) } as never);
    });
    return s;
  }) as unknown as StreamFn;
  return { streamFn, calls: () => n };
}

async function run(fn: StreamFn, signal?: AbortSignal) {
  const stream = await (fn as unknown as (m: unknown, c: unknown, o?: unknown) => Promise<{ result(): Promise<{ stopReason: string }> }>)(
    model,
    {},
    signal ? { signal } : {},
  );
  return stream.result();
}

describe('withCooldownWait', () => {
  it('waits out a short model cooldown and sends the same request again', async () => {
    const waited: number[] = [];
    const src = scripted([{ cooldown: 39 }, { cooldown: 6 }, 'ok']);
    const r = await run(withCooldownWait(src.streamFn, async (ms) => void waited.push(ms)));
    expect(r.stopReason).toBe('stop');
    expect(src.calls()).toBe(3);
    expect(waited).toEqual([40_000, 7_000]);
  });

  it('does not wait for a cooldown measured in hours', async () => {
    const waited: number[] = [];
    const src = scripted([{ cooldown: 8163 }, 'ok']);
    const r = await run(withCooldownWait(src.streamFn, async (ms) => void waited.push(ms)));
    expect(r.stopReason).toBe('error');
    expect(src.calls()).toBe(1);
    expect(waited).toEqual([]);
  });

  it('gives up after a bounded number of waits', async () => {
    const src = scripted([{ cooldown: 10 }]);
    const r = await run(withCooldownWait(src.streamFn, async () => undefined));
    expect(r.stopReason).toBe('error');
    expect(src.calls()).toBe(4);
  });

  it('does not resend once the request has produced output', async () => {
    const src = scripted(['fail-after-text', 'ok']);
    const r = await run(withCooldownWait(src.streamFn, async () => undefined));
    expect(r.stopReason).toBe('error');
    expect(src.calls()).toBe(1);
  });

  it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController();
    const src = scripted([{ cooldown: 10 }, 'ok']);
    const r = await run(
      withCooldownWait(src.streamFn, async () => controller.abort()),
      controller.signal,
    );
    expect(r.stopReason).toBe('error');
    expect(src.calls()).toBe(1);
  });
});

describe('shortCooldownWaitMs', () => {
  it('only covers model cooldowns with a short reset', () => {
    expect(shortCooldownWaitMs(cooldown(21))).toBe(22_000);
    expect(shortCooldownWaitMs(cooldown(61))).toBeUndefined();
    expect(shortCooldownWaitMs('429 All credentials for model luna are cooling down')).toBeUndefined();
    expect(shortCooldownWaitMs('429 Too Many Requests, reset_seconds: 5')).toBeUndefined();
  });
});
