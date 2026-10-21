import { describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import {
  AUTO_RUNS_DESTRUCTIVE_EXPLOIT,
  renderForChannel,
  requiresElevatedAccess,
  runSecurityScan,
  type SecurityFinding,
} from '../src/index.js';

const FINDING: SecurityFinding = {
  id: 's1',
  title: 'SQL injection in search',
  severity: 'critical',
  category: 'sast',
  publicSummary: '搜索接口存在注入风险',
  exploitDetails: "payload: ' OR 1=1-- 可绕过过滤读取全表",
  locationPermalink: 'https://x/blob/sha/search.ts#L10',
};

describe('renderForChannel', () => {
  it('公开 PR 评论不含利用细节', () => {
    const r = renderForChannel(FINDING, 'public-pr-comment');
    expect(r.body).not.toContain('OR 1=1');
    expect(r.withheld).toContain('exploit-details');
    expect(r.body).toContain('搜索接口存在注入风险');
  });
  it('私密渠道含利用细节', () => {
    const r = renderForChannel(FINDING, 'private');
    expect(r.body).toContain('OR 1=1');
    expect(r.withheld).toHaveLength(0);
  });
});

describe('安全约束', () => {
  it('高危需更严格权限;不自动运行破坏性 exploit', () => {
    expect(requiresElevatedAccess('critical')).toBe(true);
    expect(requiresElevatedAccess('low')).toBe(false);
    expect(AUTO_RUNS_DESTRUCTIVE_EXPLOIT).toBe(false);
  });
});

describe('runSecurityScan', () => {
  it('全仓扫描经终结工具产出并 coerce 非法枚举', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(faux.toolCall('submit_security_findings', {
        findings: [{ title: 'hardcoded token', severity: 'nope', category: 'weird', publicSummary: '硬编码凭据', exploitDetails: 'token=...', locationPermalink: 'https://x#L1' }],
      })),
    ]);
    let n = 0;
    const out = await runSecurityScan({ repoContext: 'repo tree...' }, { model: faux.model, streamFn: faux.streamFn, newId: () => `sec-${(n += 1)}` });
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('medium'); // coerce
    expect(out[0]!.category).toBe('logic'); // coerce
    expect(out[0]!.id).toBe('sec-1');
  });
});
