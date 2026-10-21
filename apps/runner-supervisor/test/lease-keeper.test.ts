import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseKeeper, type LeaseKeeperOptions } from '../src/lease-keeper.js';

/**
 * Only two signals mean a lost lease: `renew()` returns false, or `lastConfirmedUntil - safetyMargin` passes.
 * A throwing or hanging renewal is not a loss by itself.
 */
const LEASE_MS = 90_000; // matches the supervisor default
const MARGIN_MS = 30_000; // leaseMs / 3
const DEADLINE_MS = LEASE_MS - MARGIN_MS;

describe('LeaseKeeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (
    renew: () => Promise<boolean>,
    over: Partial<LeaseKeeperOptions> = {},
  ): { keeper: LeaseKeeper; lost: Error[] } => {
    const lost: Error[] = [];
    const keeper = new LeaseKeeper({
      renew,
      leaseMs: LEASE_MS,
      intervalMs: 15_000,
      onLost: (error) => lost.push(error),
      ...over,
    });
    return { keeper, lost };
  };

  it('每次续租都成功 → 永不判丢', async () => {
    const renew = vi.fn(async () => true);
    const { keeper, lost } = make(renew);
    keeper.start();
    await vi.advanceTimersByTimeAsync(LEASE_MS * 3);
    expect(renew.mock.calls.length).toBeGreaterThan(3);
    expect(lost).toEqual([]);
    expect(keeper.isLost).toBe(false);
    keeper.stop();
  });

  it('续租返回 false → 立刻判丢,不等租约到期', async () => {
    const { keeper, lost } = make(async () => false);
    keeper.start();
    await vi.advanceTimersByTimeAsync(15_000); // only the first heartbeat
    expect(lost).toHaveLength(1);
    expect(keeper.isLost).toBe(true);
  });

  it('续租抛错 → 不判丢;窗口内恢复成功后继续正常续租', async () => {
    let broken = true;
    const renew = vi.fn(async () => {
      if (broken) throw new Error('postgres is restarting');
      return true;
    });
    const { keeper, lost } = make(renew);
    keeper.start();
    await vi.advanceTimersByTimeAsync(30_000); // two failures in a row, lease still far off
    expect(lost).toEqual([]);
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2);

    broken = false;
    // After recovery a full lease period passes without loss (each success extends the window).
    await vi.advanceTimersByTimeAsync(LEASE_MS * 2);
    expect(lost).toEqual([]);
    keeper.stop();
  });

  it('一直抛错 → 到 lastConfirmedUntil - safetyMargin 才判丢,且只判一次', async () => {
    const renew = vi.fn(async () => {
      throw new Error('postgres is gone');
    });
    const { keeper, lost } = make(renew);
    keeper.start();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1_000);
    expect(lost).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lost).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LEASE_MS);
    expect(lost).toHaveLength(1); // reported once
    keeper.stop();
  });

  it('续租挂住不返回 → 仍然到点判丢(挂起不能把租约丢了这件事藏起来)', async () => {
    const renew = vi.fn(() => new Promise<boolean>(() => undefined));
    const { keeper, lost } = make(renew);
    keeper.start();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 15_000);
    expect(lost).toHaveLength(1);
    expect(keeper.isLost).toBe(true);
  });

  it('单次续租有超时:没回音就换下一次重试,而不是永远占着 in-flight', async () => {
    const renew = vi.fn(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5 * 60_000)),
    );
    const { keeper, lost } = make(renew, { timeoutMs: 5_000, intervalMs: 5_000 });
    keeper.start();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 10_000);
    // Every call hits the 5s timeout: retries continue and the deadline still decides, instead of hanging on the first call.
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(lost).toHaveLength(1);
  });

  it('stop() 之后不再续租,也不判丢(跑完了收工,不是租约丢了)', async () => {
    const renew = vi.fn(async () => true);
    const { keeper, lost } = make(renew);
    keeper.start();
    await vi.advanceTimersByTimeAsync(15_000);
    const calls = renew.mock.calls.length;
    keeper.stop();
    await vi.advanceTimersByTimeAsync(LEASE_MS * 2);
    expect(renew.mock.calls.length).toBe(calls);
    expect(lost).toEqual([]);
  });

  it('leaseMs 决定死线:租约更短时更早判丢', async () => {
    const renew = vi.fn(async () => {
      throw new Error('nope');
    });
    const { keeper, lost } = make(renew, { leaseMs: 30_000, intervalMs: 5_000 });
    keeper.start();
    await vi.advanceTimersByTimeAsync(21_000); // 30s - 10s(margin) = 20s
    expect(lost).toHaveLength(1);
  });
});
