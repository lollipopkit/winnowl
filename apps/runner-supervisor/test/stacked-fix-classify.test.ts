import { describe, expect, it } from 'vitest';
import { deliveryFailure } from '../src/stacked-fix.js';
import { JobExecutionError } from '../src/supervisor.js';

/** Delivery failures are classified: lease loss and provider 429/5xx stay retryable instead of internal_bug. */
describe('stacked fix 交付失败分类(§46.1)', () => {
  it('已有分类的错误原样保留(租约丢失 → retryable_runner 可重试)', () => {
    const leaseLost = new JobExecutionError('job lease heartbeat failed', 'retryable_runner', true);
    expect(deliveryFailure(leaseLost, 'patch')).toBe(leaseLost);
  });

  it('provider 瞬时故障(429/5xx)→ retryable_provider,可重试', () => {
    for (const status of [429, 502, 503]) {
      const failure = deliveryFailure(Object.assign(new Error(`HTTP ${status}`), { status }), 'patch');
      expect(failure.failureClass).toBe('retryable_provider');
      expect(failure.retryable).toBe(true);
      expect(failure.message).toContain('stacked fix 交付失败');
    }
  });

  it('patch apply 不上(无 status)→ internal_bug 不可重试,但带上 patch 预览便于诊断', () => {
    const failure = deliveryFailure(new Error('patch does not apply'), 'line1\nline2');
    expect(failure.failureClass).toBe('internal_bug');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain('patch[0:500]=line1\\nline2');
  });
});
