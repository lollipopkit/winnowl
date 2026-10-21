import { describe, expect, it } from 'vitest';
import {
  checkRateLimit,
  hasPermission,
  isAdminRole,
  redactForFrontend,
  scopesForRole,
  tokenHasScope,
} from '../src/index.js';

describe('roles / permissions', () => {
  it('viewer 只读;member 可触发但不能批准;admin 可批准 learning', () => {
    expect(hasPermission('viewer', 'review:read')).toBe(true);
    expect(hasPermission('viewer', 'review:trigger')).toBe(false);
    expect(hasPermission('member', 'review:trigger')).toBe(true);
    expect(hasPermission('member', 'learning:approve')).toBe(false);
    expect(hasPermission('admin', 'learning:approve')).toBe(true);
    expect(hasPermission('owner', 'worker:kill')).toBe(true);
  });
  it('isAdminRole', () => {
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('member')).toBe(false);
  });
  it('member:manage admin+;billing:manage 仅 owner;plan:read 全员', () => {
    expect(hasPermission('admin', 'member:manage')).toBe(true);
    expect(hasPermission('member', 'member:manage')).toBe(false);
    expect(hasPermission('owner', 'billing:manage')).toBe(true);
    expect(hasPermission('admin', 'billing:manage')).toBe(false);
    expect(hasPermission('viewer', 'plan:read')).toBe(true);
  });
  it('scopesForRole:admin/owner→admin;member 可触发;viewer 只读', () => {
    expect(scopesForRole('owner')).toContain('admin');
    expect(scopesForRole('admin')).toContain('admin');
    expect(scopesForRole('member')).toEqual(['repo:read', 'review:trigger', 'audit:read']);
    expect(scopesForRole('viewer')).toEqual(['repo:read', 'audit:read']);
    // member can trigger reviews but cannot write
    expect(tokenHasScope(scopesForRole('member'), 'review:trigger')).toBe(true);
    expect(tokenHasScope(scopesForRole('member'), 'repo:write')).toBe(false);
    expect(tokenHasScope(scopesForRole('admin'), 'repo:write')).toBe(true);
  });
});

describe('scopes / provider token 保护', () => {
  it('scope 校验,admin 覆盖', () => {
    expect(tokenHasScope(['repo:read'], 'repo:read')).toBe(true);
    expect(tokenHasScope(['repo:read'], 'repo:write')).toBe(false);
    expect(tokenHasScope(['admin'], 'repo:write')).toBe(true);
  });
  it('前端响应剔除 Provider Token/密钥(深度)', () => {
    const r = redactForFrontend({
      id: 'r1',
      providerToken: 'ghp_secret',
      nested: { installationToken: 'x', name: 'ok' },
      list: [{ apiSecret: 's', keep: 1 }],
    }) as Record<string, unknown>;
    expect(r.providerToken).toBeUndefined();
    expect((r.nested as Record<string, unknown>).installationToken).toBeUndefined();
    expect((r.nested as Record<string, unknown>).name).toBe('ok');
    expect(((r.list as Record<string, unknown>[])[0]!).apiSecret).toBeUndefined();
    expect(((r.list as Record<string, unknown>[])[0]!).keep).toBe(1);
  });
});

describe('checkRateLimit', () => {
  it('窗口内计数放行,达上限拒绝,窗口过期重置', () => {
    let state;
    const opts = (now: number) => ({ limit: 2, windowMs: 1000, now });
    let r = checkRateLimit(state, opts(0));
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
    r = checkRateLimit(r.state, opts(100));
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);
    r = checkRateLimit(r.state, opts(200));
    expect(r.allowed).toBe(false);
    // expired window resets
    r = checkRateLimit(r.state, opts(1200));
    expect(r.allowed).toBe(true);
  });
});
