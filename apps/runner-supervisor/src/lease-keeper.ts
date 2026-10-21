/**
 * Per-job lease keeper: renews on an interval and decides exactly once whether the lease was lost
 * (aborting the handler's `AbortSignal`). A renewal that throws is not loss (the row is still ours); a
 * renewal that hangs must not hide loss either. Only evidence ends a lease: `renew()` returning false, or
 * `now` coming within `safetyMarginMs` of `lastConfirmedUntil` without a confirmed renewal.
 */
export interface LeaseKeeperOptions {
  /**
   * Renew the lease. `true` = still ours; `false` = **definitively** no longer ours (the row is
   * gone, owned by someone else, or already terminal). Anything else — a throw, or never
   * resolving — is treated as "unknown" and retried.
   */
  renew: () => Promise<boolean>;
  /** How long a successful renewal extends the lease (ms). */
  leaseMs: number;
  /** Interval between renewal attempts (ms). */
  intervalMs: number;
  /** Timeout for one renewal attempt; a call still running after this counts as unknown. */
  timeoutMs?: number;
  /** How long before the confirmed expiry to treat the lease as lost. */
  safetyMarginMs?: number;
  /** Called once, when the lease is declared lost. */
  onLost: (error: Error) => void;
  now?: () => number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class LeaseKeeper {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly safetyMarginMs: number;
  private lastConfirmedUntil: number;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private stopped = false;
  private lost = false;

  constructor(private readonly options: LeaseKeeperOptions) {
    this.now = options.now ?? Date.now;
    // A renewal that has not answered within a third of the lease is already suspicious; the
    // deadline check below is what actually decides.
    this.timeoutMs = options.timeoutMs ?? Math.max(1_000, Math.floor(options.leaseMs / 3));
    this.safetyMarginMs =
      options.safetyMarginMs ?? Math.max(1_000, Math.floor(options.leaseMs / 3));
    this.lastConfirmedUntil = this.now() + options.leaseMs;
  }

  get isLost(): boolean {
    return this.lost;
  }

  /** Start renewing on the interval. Idempotent. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
  }

  /** Stop renewing. Does not declare the lease lost — callers stop it after the job is done. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One renewal attempt (also the retry unit: a failed attempt is simply the next tick). */
  async tick(): Promise<void> {
    if (this.stopped || this.lost) return;
    if (this.inFlight) {
      /*
       * A renewal is still running. Do not stack calls on it, but keep watching the deadline:
       * a hung heartbeat is exactly the case where nothing else would ever notice the lease
       * expiring underneath us.
       */
      this.checkDeadline();
      return;
    }
    this.inFlight = true;
    try {
      const renewed = await withTimeout(this.options.renew(), this.timeoutMs, 'lease renewal');
      if (this.stopped || this.lost) return;
      if (!renewed) {
        this.declareLost(new Error('lease is no longer owned by this worker'));
        return;
      }
      this.lastConfirmedUntil = this.now() + this.options.leaseMs;
    } catch (error) {
      this.checkDeadline(error);
    } finally {
      this.inFlight = false;
    }
  }

  private checkDeadline(cause?: unknown): void {
    if (this.lost || this.stopped) return;
    if (this.now() < this.lastConfirmedUntil - this.safetyMarginMs) return;
    const detail = cause instanceof Error ? ` (${cause.message})` : '';
    this.declareLost(
      new Error(
        `lease renewal has not succeeded since ${new Date(this.lastConfirmedUntil - this.options.leaseMs).toISOString()}${detail}`,
      ),
    );
  }

  private declareLost(error: Error): void {
    if (this.lost) return;
    this.lost = true;
    this.stop();
    this.options.onLost(error);
  }
}
