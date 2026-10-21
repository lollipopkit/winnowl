import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatEventTime, formatNumber, formatRelativeTime, formatUsd } from '../src/lib/format.js';

describe('web-console format(§40 i18n formatters)', () => {
  const iso = '2026-07-17T12:34:56Z';

  it('formatNumber:按 locale 千位分隔', () => {
    expect(formatNumber(1234567, 'en')).toBe('1,234,567');
    expect(formatNumber(1234567, 'zh')).toBe('1,234,567');
    expect(formatNumber(NaN, 'en')).toBe('NaN');
  });

  it('formatUsd:currency + 至多 4 位小数', () => {
    expect(formatUsd(0.0123, 'en')).toBe('$0.0123');
    expect(formatUsd(12, 'en')).toBe('$12.00');
    expect(formatUsd(Number.POSITIVE_INFINITY, 'en')).toBe('Infinity');
  });

  it('formatDateTime:有效日期含年份;空/无效优雅回退', () => {
    expect(formatDateTime(iso, 'en')).toMatch(/2026/);
    expect(formatDateTime('', 'en')).toBe('');
    expect(formatDateTime(null, 'en')).toBe('');
    expect(formatDateTime('not-a-date', 'en')).toBe('not-a-date');
  });

  it('formatDate:仅日期(含年份)', () => {
    expect(formatDate(iso, 'zh')).toMatch(/2026/);
  });

  it('formatRelativeTime:空值回退;有效值返回相对短语', () => {
    expect(formatRelativeTime('', 'en')).toBe('');
    const past = new Date(Date.now() - 3 * 60_000).toISOString();
    expect(formatRelativeTime(past, 'en')).toMatch(/minute|min/i);
  });

  it('formatEventTime:一周内相对、更早绝对 —— 通知先看"多新",陈年条目再看日期', () => {
    const hoursAgo = new Date(Date.now() - 3 * 3_600_000);
    expect(formatEventTime(hoursAgo, 'en')).toMatch(/hour/);
    const longAgo = new Date(Date.now() - 30 * 86_400_000);
    expect(formatEventTime(longAgo, 'en')).not.toMatch(/ago/);
    expect(formatEventTime(longAgo, 'en')).toMatch(/\d{4}/);
    expect(formatEventTime(null, 'en')).toBe('');
    expect(formatEventTime('not-a-date', 'en')).toBe('not-a-date');
  });
});
