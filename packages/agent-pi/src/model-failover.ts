import { createAssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { classifyStreamFailure, cooldownResetSeconds } from './failure.js';
import type { ResolvedModelSource } from './model-source.js';

/*
 * Request-level failover: on `model_unavailable`, resend the same request to the next model in the chain, so
 * callers holding a single `{ model, streamFn }` get fallbacks too. Only before any content was emitted, so a
 * partial answer is never spliced onto another model's output. Cooldowns are kept in-process (reset_seconds,
 * default 5 min) so later requests skip the cooling model.
 */
const cooldownUntil = new Map<string, number>();
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 6 * 3600_000;

function cooldownMs(errorMessage: string | undefined): number {
  const reset = cooldownResetSeconds(errorMessage);
  const ms = reset !== undefined ? reset * 1000 : DEFAULT_COOLDOWN_MS;
  return Math.min(Math.max(ms, 1000), MAX_COOLDOWN_MS);
}

const keyOf = (m: Model<string>): string => `${m.provider}/${m.id}`;

/** For tests. */
export function resetModelCooldowns(): void {
  cooldownUntil.clear();
}

type Event = { type: string; error?: { errorMessage?: string } };

export function withModelFailover(chain: readonly ResolvedModelSource[], now: () => number = Date.now): ResolvedModelSource {
  if (chain.length === 0) throw new Error('withModelFailover: empty model chain');
  if (chain.length === 1) return chain[0]!;
  const primary = chain[0]!;

  const streamFn = ((_model: unknown, context: unknown, options?: unknown) => {
    const out = createAssistantMessageEventStream();
    const t = now();
    const first = chain.findIndex((c) => (cooldownUntil.get(keyOf(c.model)) ?? 0) <= t);
    void (async () => {
      for (let i = first < 0 ? chain.length - 1 : first; i < chain.length; i += 1) {
        const c = chain[i]!;
        const inner = await (c.streamFn as unknown as (m: unknown, ctx: unknown, o?: unknown) => Promise<AsyncIterable<Event>>)(
          c.model,
          context,
          options,
        );
        let held: Event | undefined;
        let emitted = false;
        let failedOver = false;
        for await (const ev of inner) {
          if (!emitted && ev.type === 'start') {
            held = ev;
            continue;
          }
          if (
            !emitted &&
            ev.type === 'error' &&
            i + 1 < chain.length &&
            classifyStreamFailure(ev.error?.errorMessage) === 'model_unavailable'
          ) {
            cooldownUntil.set(keyOf(c.model), now() + cooldownMs(ev.error?.errorMessage));
            failedOver = true;
            break;
          }
          if (held) out.push(held as never);
          held = undefined;
          emitted = true;
          out.push(ev as never);
        }
        if (!failedOver) {
          if (held) out.push(held as never);
          return;
        }
      }
    })().catch((error: unknown) => {
      // Same shape as a provider error: the runner only handles error events in the stream, not throws.
      out.push({
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [],
          api: primary.model.api,
          provider: primary.model.provider,
          model: primary.model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'error',
          errorMessage: (error as Error)?.message ?? String(error),
          timestamp: Date.now(),
        },
      } as never);
    });
    return out;
  }) as unknown as StreamFn;

  return { model: primary.model, streamFn, ...(primary.config ? { config: primary.config } : {}) };
}
