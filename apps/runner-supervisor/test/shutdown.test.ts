import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdown, parseDrainTimeoutMs, type ShutdownDeps } from '../src/shutdown.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(over: Partial<ShutdownDeps> & { abortStops?: boolean } = {}) {
  const run = deferred();
  const calls: string[] = [];
  const info: string[] = [];
  const warn: string[] = [];
  let jobs = [{ id: 'j1', type: 'review_revision' }];
  const deps: ShutdownDeps = {
    drainTimeoutMs: 60_000,
    stopClaiming: async () => void calls.push('stopClaiming'),
    idle: run.promise,
    inFlightJobs: () => jobs,
    heartbeat: async () => void calls.push('heartbeat'),
    abortInFlight: () => {
      calls.push('abort');
      // A well-behaved handler stops on abort; the run loop then exits.
      if (over.abortStops !== false) queueMicrotask(run.resolve);
      return jobs.map((j) => j.id);
    },
    destroySandboxes: async () => (calls.push('destroy'), 1),
    release: async (ids) => (calls.push(`release:${ids.join(',')}`), ids.length),
    log: { info: (_d, m) => void info.push(m), warn: (_d, m) => void warn.push(m) },
    ...over,
  };
  return {
    shutdown: createShutdown(deps),
    calls,
    info,
    warn,
    finishJobs: () => {
      jobs = [];
      run.resolve();
    },
  };
}

describe('createShutdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drain waits for the in-flight job and neither aborts nor releases it', async () => {
    const t = setup();
    const outcome = t.shutdown.request('SIGTERM');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(t.calls).toContain('stopClaiming');
    expect(t.calls).not.toContain('abort');
    // Worker heartbeat keeps going while draining (every 15s by default).
    expect(t.calls.filter((c) => c === 'heartbeat')).toHaveLength(3);
    t.finishJobs();
    await expect(outcome).resolves.toEqual({ kind: 'drained' });
    expect(t.calls).not.toContain('abort');
    expect(t.calls.some((c) => c.startsWith('release'))).toBe(false);
    expect(t.info).toContain('drain completed: all in-flight jobs finished');
  });

  it('logs drain progress periodically', async () => {
    const t = setup({ drainTimeoutMs: 600_000 });
    void t.shutdown.request('SIGTERM');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(t.info.filter((m) => m === 'drain in progress')).toHaveLength(3);
    t.finishJobs();
  });

  it('drain timeout falls back to abort → destroy sandboxes → release', async () => {
    const t = setup({ drainTimeoutMs: 60_000 });
    const outcome = t.shutdown.request('SIGTERM');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(t.calls).not.toContain('abort');
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({ kind: 'released', released: 1, jobs: 1 });
    expect(t.calls.filter((c) => c !== 'heartbeat')).toEqual([
      'stopClaiming',
      'abort',
      'destroy',
      'release:j1',
    ]);
  });

  it('a second signal forces the abort path immediately', async () => {
    const t = setup({ drainTimeoutMs: 3_600_000 });
    const first = t.shutdown.request('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);
    const second = t.shutdown.request('SIGTERM');
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ kind: 'released', released: 1, jobs: 1 });
    expect(t.warn).toContain('second shutdown signal: forcing abort of in-flight jobs');
  });

  it('drainTimeoutMs=0 keeps the old behaviour: abort immediately', async () => {
    const t = setup({ drainTimeoutMs: 0 });
    await expect(t.shutdown.request('SIGTERM')).resolves.toEqual({
      kind: 'released',
      released: 1,
      jobs: 1,
    });
    expect(t.info).not.toContain(
      'drain started: no new jobs are claimed; waiting for in-flight jobs to finish',
    );
  });

  it('handlers that ignore abort keep their leases for the reaper', async () => {
    const t = setup({ drainTimeoutMs: 0, abortStops: false });
    const outcome = t.shutdown.request('SIGTERM');
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(outcome).resolves.toEqual({ kind: 'abandoned', jobs: 1 });
    expect(t.calls.some((c) => c.startsWith('release'))).toBe(false);
  });
});

describe('parseDrainTimeoutMs', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['abc', 0],
    ['-5', 0],
    ['0', 0],
    ['2400000', 2_400_000],
  ])('%s → %d', (raw, expected) => expect(parseDrainTimeoutMs(raw)).toBe(expected));
});
