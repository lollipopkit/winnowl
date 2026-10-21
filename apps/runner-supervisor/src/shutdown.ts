/**
 * Runner shutdown orchestration (SIGTERM/SIGINT). Drains first: stop claiming, keep in-flight jobs
 * running (lease renewal is per job) and wait up to `drainTimeoutMs`. On timeout or a second signal it
 * falls back to abort: abort handlers → destroy sandboxes → wait `abortGraceMs` → release leases.
 * `drainTimeoutMs = 0` aborts immediately. The container stop grace period must exceed
 * `drainTimeoutMs + abortGraceMs`, or the process is SIGKILLed mid-drain and leases are left for the reaper.
 */

export interface ShutdownLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export interface ShutdownDeps {
  /** 0 = no drain. */
  drainTimeoutMs: number;
  /** Close the claim gate (worker mode → draining, supervisor.requestStop()). Must not throw. */
  stopClaiming: () => Promise<void>;
  /** Settles once the run loop has exited and every in-flight job has finished. */
  idle: Promise<unknown>;
  inFlightJobs: () => { id: string; type: string }[];
  /** Worker heartbeat; the run loop no longer sends it once stopped. */
  heartbeat: () => Promise<void>;
  abortInFlight: () => string[];
  destroySandboxes: () => Promise<number>;
  release: (ids: string[]) => Promise<number>;
  log: ShutdownLogger;
  /** Time handlers get to stop after abort before leases are released (default 8s). */
  abortGraceMs?: number;
  /** Drain progress log interval (default 60s). */
  progressIntervalMs?: number;
  /** Worker heartbeat interval while draining (default 15s). */
  heartbeatIntervalMs?: number;
  now?: () => number;
}

export type ShutdownOutcome =
  /** Every in-flight job finished during the drain; nothing to release. */
  | { kind: 'drained' }
  /** Handlers stopped within the abort grace; their leases were handed back to the queue. */
  | { kind: 'released'; released: number; jobs: number }
  /** Handlers did not stop in time; leases are kept for the reaper. */
  | { kind: 'abandoned'; jobs: number };

export interface Shutdown {
  /**
   * Signal entry point. The first call starts the shutdown; a later call while draining forces the
   * abort path. Every call returns the same outcome promise.
   */
  request(signal: string): Promise<ShutdownOutcome>;
}

export function createShutdown(deps: ShutdownDeps): Shutdown {
  const now = deps.now ?? Date.now;
  const abortGraceMs = deps.abortGraceMs ?? 8_000;
  const progressIntervalMs = deps.progressIntervalMs ?? 60_000;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? 15_000;
  // `idle` may reject (run loop crash); for shutdown purposes it still means "nothing to wait on".
  const idle = deps.idle.then(
    () => 'idle' as const,
    () => 'idle' as const,
  );

  let outcome: Promise<ShutdownOutcome> | undefined;
  let forceRequested = false;
  let force: (() => void) | undefined;
  const forced = new Promise<'forced'>((resolve) => {
    force = () => resolve('forced');
  });

  const describe = (): Record<string, unknown> => {
    const jobs = deps.inFlightJobs();
    const types: Record<string, number> = {};
    for (const j of jobs) types[j.type] = (types[j.type] ?? 0) + 1;
    return { inFlight: jobs.length, types };
  };

  const drain = async (): Promise<boolean> => {
    if (forceRequested || deps.drainTimeoutMs <= 0) return false;
    const startedAt = now();
    deps.log.info(
      { timeoutMs: deps.drainTimeoutMs, ...describe() },
      'drain started: no new jobs are claimed; waiting for in-flight jobs to finish',
    );
    const progress = setInterval(() => {
      deps.log.info(
        {
          elapsedMs: now() - startedAt,
          remainingMs: Math.max(0, deps.drainTimeoutMs - (now() - startedAt)),
          ...describe(),
        },
        'drain in progress',
      );
    }, progressIntervalMs);
    const heartbeat = setInterval(() => {
      void deps
        .heartbeat()
        .catch((error) =>
          deps.log.warn({ error: String(error) }, 'drain: worker heartbeat failed'),
        );
    }, heartbeatIntervalMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deps.drainTimeoutMs);
    });
    try {
      const result = await Promise.race([idle, timeout, forced]);
      if (result === 'idle') {
        deps.log.info(
          { elapsedMs: now() - startedAt },
          'drain completed: all in-flight jobs finished',
        );
        return true;
      }
      deps.log.warn(
        { reason: result, elapsedMs: now() - startedAt, ...describe() },
        'drain ended before in-flight jobs finished; aborting them',
      );
      return false;
    } finally {
      clearInterval(progress);
      clearInterval(heartbeat);
      clearTimeout(timer);
    }
  };

  const run = async (signal: string): Promise<ShutdownOutcome> => {
    deps.log.info({ signal, drainTimeoutMs: deps.drainTimeoutMs }, 'runner shutdown started');
    await deps.stopClaiming();
    if (await drain()) return { kind: 'drained' };

    const interrupted = deps.abortInFlight();
    const destroyed = await deps.destroySandboxes().catch(() => 0);
    if (destroyed > 0)
      deps.log.info({ destroyed }, 'shutdown: destroyed in-flight review sandboxes');

    // Only once handlers have actually stopped is it safe to hand the leases back; otherwise a new
    // claimer would run in parallel with a still-exiting handler. On timeout the reaper reclaims.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stoppedInTime = await Promise.race([
      idle.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), abortGraceMs);
      }),
    ]);
    clearTimeout(timer);
    if (!stoppedInTime) {
      deps.log.warn(
        { jobs: interrupted.length },
        'shutdown grace exhausted: leases kept for the reaper instead of racing exiting handlers',
      );
      return { kind: 'abandoned', jobs: interrupted.length };
    }
    const released = await deps.release(interrupted).catch(() => 0);
    if (released > 0)
      deps.log.info(
        { released },
        'shutdown: in-flight jobs released to the queue (attempt not counted)',
      );
    return { kind: 'released', released, jobs: interrupted.length };
  };

  return {
    request(signal) {
      if (outcome) {
        if (!forceRequested) {
          forceRequested = true;
          deps.log.warn({ signal }, 'second shutdown signal: forcing abort of in-flight jobs');
          force?.();
        }
        return outcome;
      }
      outcome = run(signal);
      return outcome;
    },
  };
}

/** Parse `RUNNER_DRAIN_TIMEOUT_MS`; anything missing, negative or non-numeric means 0 (no drain). */
export function parseDrainTimeoutMs(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
