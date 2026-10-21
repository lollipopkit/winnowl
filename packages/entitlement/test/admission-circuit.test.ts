import { describe, expect, it } from 'vitest';
import { decideAdmission, effectiveDailyCapUsd, effectiveReviewCapUsd, parseAllowlist, parseProvisionMode, startOfUtcDay } from '../src/index.js';

describe('租户开通准入(2026-07-30)', () => {
  it('默认(未设/误配)= allowlist —— 拼错 env 不会变成敞开', () => {
    expect(parseProvisionMode(undefined)).toBe('allowlist');
    expect(parseProvisionMode('')).toBe('allowlist');
    expect(parseProvisionMode('OPEN_')).toBe('allowlist');
    expect(parseProvisionMode('opne')).toBe('allowlist');
    expect(parseProvisionMode('open')).toBe('open');
    expect(parseProvisionMode(' Closed ')).toBe('closed');
  });

  it('名单解析:去空白、小写、忽略空项', () => {
    expect(parseAllowlist(' Acme , , piGuk ')).toEqual(['acme', 'piguk']);
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it('allowlist:名单内开通,名单外**记待批而非丢弃**(否则对方装了 App 毫无反馈)', () => {
    const list = ['acme', 'piguk'];
    expect(decideAdmission({ mode: 'allowlist', allowlist: list, accountLogin: 'ACME' }).action).toBe('provision');
    const out = decideAdmission({ mode: 'allowlist', allowlist: list, accountLogin: 'stranger' });
    expect(out.action).toBe('pending');
    expect(out.reason).toContain('stranger');
  });

  it('空名单 = 谁都不自动开通(但仍记待批)', () => {
    expect(decideAdmission({ mode: 'allowlist', allowlist: [], accountLogin: 'anyone' }).action).toBe('pending');
  });

  it('通配符 * 等价放行全部(留给有了计费与额度强制之后)', () => {
    expect(decideAdmission({ mode: 'allowlist', allowlist: ['*'], accountLogin: 'anyone' }).action).toBe('provision');
  });

  it('open 全放行;closed 连待批都不记', () => {
    expect(decideAdmission({ mode: 'open', allowlist: [], accountLogin: 'x' }).action).toBe('provision');
    expect(decideAdmission({ mode: 'closed', allowlist: ['x'], accountLogin: 'x' }).action).toBe('reject');
  });
});

describe('单日成本熔断:UTC 切日', () => {
  it('按 UTC 零点切,避免时区歧义(review_costs.created_at 是 timestamptz)', () => {
    const d = startOfUtcDay(Date.UTC(2026, 6, 30, 23, 59, 59));
    expect(d.toISOString()).toBe('2026-07-30T00:00:00.000Z');
    expect(startOfUtcDay(Date.UTC(2026, 6, 30, 0, 0, 1)).getTime()).toBe(d.getTime());
    expect(startOfUtcDay(Date.UTC(2026, 6, 31)).getTime() - d.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

// Plan wins over env and 0 means explicitly uncapped, so the check must not be a truthiness test.
describe('成本上限:计划优先于 env(0049 日线 / 0065 单跑)', () => {
  it('计划未配(null)→ 继承 env', () => {
    expect(effectiveDailyCapUsd(null, 20)).toBe(20);
    expect(effectiveReviewCapUsd(null, 3)).toBe(3);
  });

  it('计划配了数 → 用计划的,env 不参与', () => {
    expect(effectiveDailyCapUsd(50, 20)).toBe(50);
    expect(effectiveReviewCapUsd(10, 3)).toBe(10);
  });

  it('计划配 0(显式不限)→ 压过 env,不被兜底覆盖', () => {
    expect(effectiveDailyCapUsd(0, 20)).toBe(0);
    expect(effectiveReviewCapUsd(0, 3)).toBe(0);
  });
});
