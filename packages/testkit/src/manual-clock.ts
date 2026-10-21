/**
 * Structurally a review-engine `StageClock`. Time moves only on `advance(ms)`; `timeout(ms)` signals
 * abort synchronously once passed, with the same `TimeoutError` reason as `AbortSignal.timeout`.
 */
export interface ManualClock {
  now: () => number;
  timeout: (ms: number) => AbortSignal;
  advance: (ms: number) => void;
}

export function createManualClock(start = 0): ManualClock {
  let current = start;
  let pending: { dueAt: number; controller: AbortController }[] = [];
  return {
    now: () => current,
    timeout: (ms) => {
      const controller = new AbortController();
      pending.push({ dueAt: current + ms, controller });
      return controller.signal;
    },
    advance: (ms) => {
      current += ms;
      const due = pending.filter((t) => t.dueAt <= current);
      pending = pending.filter((t) => t.dueAt > current);
      for (const { controller } of due)
        controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    },
  };
}
