import { describe, expect, it } from 'vitest';
import { BACKOFF_POLICIES, backoffPolicyFor, computeBackoffSeconds, DEFAULT_BACKOFF_POLICY } from '../src/backoff.js';

describe('退避策略(§10.3)', () => {
  it('按 failureClass 分档:网关故障等分钟级,执行面瞬时故障等秒级', () => {
    expect(backoffPolicyFor('retryable_model').baseSeconds).toBe(30);
    expect(backoffPolicyFor('retryable_runner').baseSeconds).toBe(5);
    expect(backoffPolicyFor('retryable_model').baseSeconds).toBeGreaterThan(
      backoffPolicyFor('retryable_runner').baseSeconds,
    );
  });

  it('未列出的 class 走兜底档', () => {
    expect(backoffPolicyFor('internal_bug')).toEqual(DEFAULT_BACKOFF_POLICY);
  });

  it('equal jitter:等待落在 [d/2, d],且随尝试次数翻倍', () => {
    const policy = { baseSeconds: 30, capSeconds: 300 };
    expect(computeBackoffSeconds(1, policy, () => 0)).toBe(15);
    expect(computeBackoffSeconds(1, policy, () => 1)).toBe(30);
    expect(computeBackoffSeconds(2, policy, () => 0)).toBe(30);
    expect(computeBackoffSeconds(2, policy, () => 1)).toBe(60);
    expect(computeBackoffSeconds(3, policy, () => 0.5)).toBe(90); // window 120 -> 60 + 0.5*60
  });

  it('抖动是真的抖:同一次尝试的等待不是常数(否则并发 job 会永远同步重试)', () => {
    const policy = BACKOFF_POLICIES.retryable_model!;
    const samples = new Set(Array.from({ length: 20 }, () => computeBackoffSeconds(1, policy)));
    expect(samples.size).toBeGreaterThan(1);
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(15);
      expect(s).toBeLessThanOrEqual(30);
    }
  });

  it('cap 截住指数增长(maxAttempts 调大后退避不失控)', () => {
    const policy = { baseSeconds: 30, capSeconds: 300 };
    expect(computeBackoffSeconds(99, policy, () => 1)).toBe(300);
  });

  it('review_revision 的 4 次尝试在 retryable_model 档下覆盖分钟级坏窗口', () => {
    const policy = BACKOFF_POLICIES.retryable_model!;
    const total = (rand: number): number =>
      [1, 2, 3].reduce((sum, attempt) => sum + computeBackoffSeconds(attempt, policy, () => rand), 0);
    // 4 attempts = 3 waits: expected 157.5s, upper bound 210s, enough to outlast a ~106s gateway outage.
    expect(total(0.5)).toBeGreaterThan(106);
    expect(total(1)).toBeLessThanOrEqual(240);
    expect(total(0)).toBe(105);
  });
});
