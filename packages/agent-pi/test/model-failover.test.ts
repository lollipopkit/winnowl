import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModelCooldowns, withModelFailover, type ResolvedModelSource, type StreamFn } from '../src/index.js';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = (id: string) => ({ id, provider: 'openai', api: 'openai-completions' }) as unknown as Model<string>;
const message = (id: string, extra: Record<string, unknown>) => ({ role: 'assistant', content: [], api: 'openai-completions', provider: 'openai', model: id, usage, timestamp: 0, ...extra });

/** Fake model: returns a cooldown error when `fail`, otherwise text; counts calls. */
function source(id: string, behaviour: 'cooldown' | 'ok' | 'fail-after-text', calls: string[]): ResolvedModelSource {
  const streamFn = ((m: Model<string>) => {
    calls.push(m.id);
    const s = createAssistantMessageEventStream();
    queueMicrotask(() => {
      s.push({ type: 'start', partial: message(id, { stopReason: 'pending' }) } as never);
      if (behaviour === 'cooldown') {
        s.push({ type: 'error', reason: 'error', error: message(id, { stopReason: 'error', errorMessage: `429 {"error":{"code":"model_cooldown","message":"All credentials for model ${id} are cooling down","reset_seconds":8163}}` }) } as never);
        return;
      }
      s.push({ type: 'text_start', contentIndex: 0, partial: message(id, { stopReason: 'pending' }) } as never);
      if (behaviour === 'fail-after-text') {
        s.push({ type: 'error', reason: 'error', error: message(id, { stopReason: 'error', errorMessage: 'model_cooldown' }) } as never);
        return;
      }
      s.push({ type: 'done', reason: 'stop', message: message(id, { stopReason: 'stop', content: [{ type: 'text', text: `from ${id}` }] }) } as never);
    });
    return s;
  }) as unknown as StreamFn;
  return { model: model(id), streamFn };
}

async function run(src: ResolvedModelSource) {
  const stream = await (src.streamFn as unknown as (m: unknown, c: unknown) => Promise<{ result(): Promise<{ model: string; stopReason: string }> }>)(src.model, {});
  return stream.result();
}

describe('withModelFailover', () => {
  afterEach(() => resetModelCooldowns());

  it('sends the request to the next model when the first has no quota, and skips it while it cools down', async () => {
    const calls: string[] = [];
    const chain = withModelFailover([source('luna', 'cooldown', calls), source('ds', 'ok', calls)]);
    expect((await run(chain)).model).toBe('ds');
    expect((await run(chain)).model).toBe('ds');
    expect(calls).toEqual(['luna', 'ds', 'ds']);
  });

  it('does not switch once the first model has produced output', async () => {
    const calls: string[] = [];
    const chain = withModelFailover([source('luna', 'fail-after-text', calls), source('ds', 'ok', calls)]);
    expect((await run(chain)).stopReason).toBe('error');
    expect(calls).toEqual(['luna']);
  });

  it('a single-model chain is the model itself', () => {
    const only = source('luna', 'ok', []);
    expect(withModelFailover([only])).toBe(only);
  });
});
