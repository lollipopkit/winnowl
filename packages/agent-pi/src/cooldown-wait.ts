import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { classifyStreamFailure, cooldownResetSeconds } from './failure.js';

/*
 * On a short gateway `model_cooldown` (credential rotation, reset_seconds of tens of seconds), wait and resend
 * the same request instead of failing the whole invocation. Only before any content was emitted. Longer or
 * unknown cooldowns still fail and go to model fallback / job retry.
 */
const MAX_WAIT_SECONDS = 60;
const MAX_WAITS = 3;

type Event = { type: string; error?: { errorMessage?: string } };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wait time for a short cooldown; undefined when not worth waiting. */
export function shortCooldownWaitMs(errorMessage: string | undefined): number | undefined {
  if (classifyStreamFailure(errorMessage) !== 'model_unavailable') return undefined;
  const reset = cooldownResetSeconds(errorMessage);
  if (reset === undefined || reset > MAX_WAIT_SECONDS) return undefined;
  // +1s: reset_seconds is rounded down.
  return (reset + 1) * 1000;
}

export function withCooldownWait(
  inner: StreamFn,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
): StreamFn {
  return ((model: unknown, context: unknown, options?: unknown) => {
    const out = createAssistantMessageEventStream();
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    void (async () => {
      for (let waits = 0; ; waits += 1) {
        const stream = await (inner as unknown as (m: unknown, ctx: unknown, o?: unknown) => Promise<AsyncIterable<Event>>)(
          model,
          context,
          options,
        );
        let held: Event | undefined;
        let emitted = false;
        let retry = false;
        for await (const ev of stream) {
          if (!emitted && ev.type === 'start') {
            held = ev;
            continue;
          }
          if (!emitted && ev.type === 'error' && waits < MAX_WAITS && !signal?.aborted) {
            const ms = shortCooldownWaitMs(ev.error?.errorMessage);
            if (ms !== undefined) {
              await wait(ms, signal);
              // Aborted while waiting: pass the error through.
              if (!signal?.aborted) {
                retry = true;
                break;
              }
            }
          }
          if (held) out.push(held as never);
          held = undefined;
          emitted = true;
          out.push(ev as never);
        }
        if (!retry) {
          if (held) out.push(held as never);
          return;
        }
      }
    })().catch((error: unknown) => {
      // Same shape as a provider error: the runner only handles error events in the stream, not throws.
      const m = model as { api?: string; provider?: string; id?: string };
      out.push({
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [],
          api: m.api,
          provider: m.provider,
          model: m.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'error',
          errorMessage: (error as Error)?.message ?? String(error),
          timestamp: Date.now(),
        },
      } as never);
    });
    return out;
  }) as unknown as StreamFn;
}
