/** Counting semaphore; unlike mapConcurrent, work can arrive over time (pipelined). */
export function makeSemaphore(limit: number): { acquire: () => Promise<void>; release: () => void } {
  let active = 0;
  const waiters: (() => void)[] = [];
  return {
    acquire: () =>
      new Promise<void>((resolve) => {
        if (active < limit) {
          active += 1;
          resolve();
        } else {
          waiters.push(resolve);
        }
      }),
    release: () => {
      const next = waiters.shift();
      if (next)
        next(); // hand the slot to the waiter; active unchanged
      else active -= 1;
    },
  };
}
