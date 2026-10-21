import { describe, expect, it } from 'vitest';
import {
  completeErasure,
  DEFAULT_RETENTION,
  expiryAt,
  isExpired,
  planInstallationErasure,
  resolveRetention,
} from '../src/index.js';

const DAY = 86_400_000;

describe('resolveRetention', () => {
  it('默认策略', () => {
    expect(DEFAULT_RETENTION.checkout).toBe('immediate');
    expect(DEFAULT_RETENTION['agent-transcript']).toBe(30);
    expect(DEFAULT_RETENTION.audit).toBe(365);
    expect(DEFAULT_RETENTION['review-progress']).toBe(30);
  });
  it('Admin 缩短生效,延长被拒(clamp 到默认)', () => {
    const r = resolveRetention({ 'agent-transcript': 7, audit: 3650 });
    expect(r['agent-transcript']).toBe(7); // shortened
    expect(r.audit).toBe(365); // extension ignored
  });
  it('checkout 恒 immediate,不可放宽', () => {
    expect(resolveRetention({ checkout: 30 }).checkout).toBe('immediate');
  });
  it('finding-metadata 可被收紧为 TTL', () => {
    expect(resolveRetention({ 'finding-metadata': 90 })['finding-metadata']).toBe(90);
  });
});

describe('expiryAt / isExpired', () => {
  it('immediate 立即过期;while-active 不按时间过期;数值按天', () => {
    expect(expiryAt('immediate', 1000)).toBe(1000);
    expect(expiryAt('while-installation-active', 1000)).toBeNull();
    expect(expiryAt(30, 0)).toBe(30 * DAY);
    expect(isExpired(30, 0, 30 * DAY)).toBe(true);
    expect(isExpired(30, 0, 29 * DAY)).toBe(false);
    expect(isExpired('while-installation-active', 0, 10 ** 15)).toBe(false);
  });
});

describe('擦除任务与审计', () => {
  it('规划擦除排除 audit,生成审计证明', () => {
    const task = planInstallationErasure('inst-1', { checkout: 0, 'agent-transcript': 5, audit: 100 }, 1000);
    expect(task.resources.map((r) => r.class).sort()).toEqual(['agent-transcript']);
    expect(task.status).toBe('pending');
    const proof = completeErasure(task, 2000);
    expect(proof).toMatchObject({ installationId: 'inst-1', status: 'completed', completedAt: 2000 });
    expect(proof.erasedCounts['agent-transcript']).toBe(5);
    expect(proof.erasedCounts.audit).toBeUndefined();
  });
});
