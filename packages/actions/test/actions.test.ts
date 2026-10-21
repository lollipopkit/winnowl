import { describe, expect, it } from 'vitest';
import { canExecutePlan, evaluatePolicy, type ActionPlan } from '../src/index.js';

describe('evaluatePolicy', () => {
  it('merge 永远禁止', () => {
    const d = evaluatePolicy({
      action: 'merge',
      actorIsRepoAdmin: true,
      repoPolicy: { mergeGovernanceEnabled: true },
    });
    expect(d.allowed).toBe(false);
  });

  it('approve/request-changes 默认禁用,启用后需 admin + 确认', () => {
    expect(evaluatePolicy({ action: 'approve', actorIsRepoAdmin: true }).allowed).toBe(false);
    const enabled = evaluatePolicy({
      action: 'approve',
      actorIsRepoAdmin: true,
      repoPolicy: { mergeGovernanceEnabled: true },
    });
    expect(enabled).toMatchObject({
      allowed: true,
      requiresConfirmation: true,
      requiresAdmin: true,
    });
  });

  it('read-only 自动允许', () => {
    expect(evaluatePolicy({ action: 'explain', actorIsRepoAdmin: false })).toMatchObject({
      allowed: true,
      requiresConfirmation: false,
    });
  });

  it('create-stacked-pr(branch-write)需确认', () => {
    expect(evaluatePolicy({ action: 'create-stacked-pr', actorIsRepoAdmin: false })).toMatchObject({
      allowed: true,
      requiresConfirmation: true,
    });
  });

  it('§37 autofix.require_confirmation=false → branch-write 免确认(仍 allowed,不需 admin)', () => {
    expect(
      evaluatePolicy({
        action: 'create-stacked-pr',
        actorIsRepoAdmin: false,
        repoPolicy: { autofix: { enabled: true, requireConfirmation: false } },
      }),
    ).toMatchObject({ allowed: true, requiresConfirmation: false, requiresAdmin: false });
    // create-cr-from-issue is also branch-write and shares the switch.
    expect(
      evaluatePolicy({
        action: 'create-cr-from-issue',
        actorIsRepoAdmin: false,
        repoPolicy: { autofix: { enabled: true, requireConfirmation: false } },
      }).requiresConfirmation,
    ).toBe(false);
    expect(
      evaluatePolicy({
        action: 'create-stacked-pr',
        actorIsRepoAdmin: false,
        repoPolicy: { autofix: { enabled: true } },
      }).requiresConfirmation,
    ).toBe(true);
  });

  it('安全底线不因免确认放宽:merge 恒禁、approve 仍需 merge governance', () => {
    const repoPolicy = { autofix: { enabled: true, requireConfirmation: false } };
    expect(evaluatePolicy({ action: 'merge', actorIsRepoAdmin: true, repoPolicy }).allowed).toBe(
      false,
    );
    expect(evaluatePolicy({ action: 'approve', actorIsRepoAdmin: true, repoPolicy }).allowed).toBe(
      false,
    );
  });

  it('create-issue 按配置;未启用则拒绝', () => {
    expect(evaluatePolicy({ action: 'create-issue', actorIsRepoAdmin: false }).allowed).toBe(false);
    expect(
      evaluatePolicy({
        action: 'create-issue',
        actorIsRepoAdmin: false,
        repoPolicy: { createIssue: { enabled: true, requireConfirmation: true } },
      }),
    ).toMatchObject({ allowed: true, requiresConfirmation: true });
  });

  it('approve-learning 需 repo admin', () => {
    expect(evaluatePolicy({ action: 'approve-learning', actorIsRepoAdmin: true })).toMatchObject({
      requiresAdmin: true,
    });
  });
});

describe('canExecutePlan', () => {
  const plan: ActionPlan = {
    id: 'p1',
    conversationId: 'conv1',
    actorId: 'alice',
    revisionSha: 'head-1',
    actions: [{ type: 'create-stacked-pr', description: 'fix' }],
    requiredPermissions: [],
    expiresAt: 2_000_000_000_000,
    status: 'proposed',
  };
  const attempt = {
    planId: 'p1',
    actorId: 'alice',
    conversationId: 'conv1',
    currentHeadSha: 'head-1',
    now: 1_000_000_000_000,
  };
  const opts = { repoAllows: true, actorPermissionValid: true };

  it('全部匹配 → 可执行', () => {
    expect(canExecutePlan(plan, attempt, opts).ok).toBe(true);
  });

  it('Actor 不符 → 拒绝', () => {
    expect(canExecutePlan(plan, { ...attempt, actorId: 'bob' }, opts)).toMatchObject({
      ok: false,
      reason: 'actor mismatch',
    });
  });

  it('system-generated plans may be approved by any authorized actor', () => {
    expect(
      canExecutePlan(
        { ...plan, actorId: 'winnowl-auto-issue', approvalActor: 'any-authorized' },
        { ...attempt, actorId: 'maintainer' },
        opts,
      ).ok,
    ).toBe(true);
  });

  it('Head 变化 → 拒绝', () => {
    expect(canExecutePlan(plan, { ...attempt, currentHeadSha: 'head-2' }, opts)).toMatchObject({
      ok: false,
      reason: 'head changed',
    });
  });

  it('计划绑定了 revision 时必须提供服务端解析出的当前 Head', () => {
    expect(canExecutePlan(plan, { ...attempt, currentHeadSha: undefined }, opts)).toMatchObject({
      ok: false,
      reason: 'current head unavailable',
    });
  });

  it('过期 → 拒绝', () => {
    expect(canExecutePlan(plan, { ...attempt, now: 3_000_000_000_000 }, opts)).toMatchObject({
      ok: false,
      reason: 'plan expired',
    });
  });

  it('Repo 策略拒绝 / 权限失效 → 拒绝', () => {
    expect(canExecutePlan(plan, attempt, { ...opts, repoAllows: false }).ok).toBe(false);
    expect(canExecutePlan(plan, attempt, { ...opts, actorPermissionValid: false }).ok).toBe(false);
  });
});
