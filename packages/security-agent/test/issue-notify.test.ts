import { describe, expect, it } from 'vitest';
import { combineNotifiers, createIssueSecurityNotifier, securityFindingFingerprint } from '../src/index.js';
import type { SecurityFinding } from '../src/types.js';

function finding(over: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    id: 'run-specific-id',
    title: 'SQL injection in user lookup',
    severity: 'critical',
    category: 'sast',
    publicSummary: 'User input is concatenated into a query.',
    exploitDetails: "curl '/users?id=1 OR 1=1--'",
    locationPermalink: 'src/db/users.ts#L42',
    ...over,
  };
}

describe('security-issue 渠道(§35)', () => {
  it('默认披露不含 exploit 细节(issue 可能对全世界可见)', async () => {
    const created: { title: string; body: string; labels: string[] }[] = [];
    const n = createIssueSecurityNotifier({ createIssue: async (i) => { created.push(i); } });
    await n.notify(finding());
    expect(created).toHaveLength(1);
    expect(created[0]!.body).not.toContain('OR 1=1');
    expect(created[0]!.body).toContain('withheld');
    expect(created[0]!.title).toBe('[security] SQL injection in user lookup');
  });

  it('显式 disclosure=full 才带 exploit', async () => {
    const created: { body: string }[] = [];
    const n = createIssueSecurityNotifier({ disclosure: 'full', createIssue: async (i) => { created.push(i); } });
    await n.notify(finding());
    expect(created[0]!.body).toContain('OR 1=1');
  });

  it('低于 minSeverity(默认 high)不建 issue', async () => {
    let calls = 0;
    const n = createIssueSecurityNotifier({ createIssue: async () => { calls += 1; } });
    await n.notify(finding({ severity: 'medium' }));
    await n.notify(finding({ severity: 'low' }));
    expect(calls).toBe(0);
    await n.notify(finding({ severity: 'high' }));
    expect(calls).toBe(1);
  });

  it('指纹跨扫描轮次稳定(不含每轮新生成的 finding.id)', () => {
    const a = securityFindingFingerprint(finding({ id: 'run-1' }));
    const b = securityFindingFingerprint(finding({ id: 'run-2' }));
    expect(a).toBe(b);
    // A different location is a different finding.
    expect(securityFindingFingerprint(finding({ locationPermalink: 'src/other.ts#L1' }))).not.toBe(a);
  });

  it('已报过的指纹跳过(provider issues.create 无幂等,定时扫描会重复建)', async () => {
    const reported = new Set<string>();
    let calls = 0;
    const n = createIssueSecurityNotifier({
      createIssue: async () => { calls += 1; },
      wasReported: async (fp) => reported.has(fp),
      onReported: async (fp) => { reported.add(fp); },
    });
    await n.notify(finding());
    await n.notify(finding({ id: 'another-run' })); // same issue, next scan
    expect(calls).toBe(1);
  });
});

describe('combineNotifiers', () => {
  it('全部渠道都投递;单渠道失败不影响其它', async () => {
    const hit: string[] = [];
    const n = combineNotifiers(
      { notify: async () => { throw new Error('smtp down'); } },
      { notify: async () => { hit.push('issue'); } },
    );
    await expect(n!.notify(finding())).resolves.toBeUndefined();
    expect(hit).toEqual(['issue']);
  });

  it('全部失败 → 抛错(调用方可记日志)', async () => {
    const n = combineNotifiers(
      { notify: async () => { throw new Error('a'); } },
      { notify: async () => { throw new Error('b'); } },
    );
    await expect(n!.notify(finding())).rejects.toThrow(/全部安全通知渠道投递失败/);
  });

  it('无渠道 → undefined;单渠道 → 原样返回', async () => {
    expect(combineNotifiers(undefined, undefined)).toBeUndefined();
    const only = { notify: async (): Promise<void> => undefined };
    expect(combineNotifiers(undefined, only)).toBe(only);
  });
});
