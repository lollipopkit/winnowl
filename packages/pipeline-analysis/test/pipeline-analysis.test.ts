import { describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import {
  analyzeRootCause,
  assessCiTrust,
  correlateWithChanges,
  decideComment,
  normalizeDiagnostics,
  redactSecrets,
  type FailedJob,
} from '../src/index.js';

describe('redactSecrets', () => {
  it('脱敏 token / KV / URL 凭据 / PEM,保留前缀', () => {
    const r = redactSecrets(
      [
        'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcdefghijklmnopqrstuvwxyz12',
        'clone https://user:supersecret@github.com/acme/app.git',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      ].join('\n'),
    );
    expect(r.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(r.text).not.toContain('supersecret');
    expect(r.text).not.toContain('wJalrXUtnFEMI');
    expect(r.text).toContain('[REDACTED]');
    expect(r.text).toContain('AWS_SECRET_ACCESS_KEY=');
    expect(r.text).toContain('https://user:[REDACTED]@github.com');
    expect(r.redactedCount).toBeGreaterThanOrEqual(4);
  });
});

describe('normalizeDiagnostics', () => {
  it('解析 tsc / eslint / python / go 格式', () => {
    const log = [
      'src/a.ts(12,5): error TS2345: Argument of type string',
      'src/b.js:8:3: error Unexpected token',
      '  File "app.py", line 42, in run',
      './pkg/x.go:5:1: undefined: Foo',
      'npm ERR! build failed',
    ].join('\n');
    const diags = normalizeDiagnostics(log);
    expect(diags.find((d) => d.tool === 'tsc')).toMatchObject({ file: 'src/a.ts', line: 12, column: 5 });
    expect(diags.find((d) => d.tool === 'python')).toMatchObject({ file: 'app.py', line: 42 });
    expect(diags.find((d) => d.tool === 'go')).toMatchObject({ file: './pkg/x.go', line: 5 });
    // failure lines without a location are kept
    expect(diags.some((d) => d.message.includes('npm ERR!'))).toBe(true);
  });
});

describe('correlateWithChanges', () => {
  it('按变更行标注 onChangedCode', () => {
    const diags = normalizeDiagnostics('src/a.ts(12,5): error TS1: x\nsrc/z.ts(3,1): error TS2: y');
    const out = correlateWithChanges(diags, {
      isChangedFile: (p) => p === 'src/a.ts',
      isChangedLine: (p, l) => p === 'src/a.ts' && l === 12,
    });
    expect(out.find((d) => d.file === 'src/a.ts')?.onChangedCode).toBe(true);
    expect(out.find((d) => d.file === 'src/z.ts')?.onChangedCode).toBe(false);
  });
});

describe('assessCiTrust', () => {
  it('Head 不一致 / flaky / 被改 workflow 都记 caveat', () => {
    const t = assessCiTrust({
      jobHeadSha: 'old',
      currentHeadSha: 'new',
      logsComplete: true,
      flaky: true,
      trustedEnvironment: true,
      workflowModifiedByUntrustedPr: true,
    });
    expect(t.trustworthy).toBe(false);
    expect(t.caveats.length).toBe(3);
    const clean = assessCiTrust({ jobHeadSha: 'h', currentHeadSha: 'h', logsComplete: true, flaky: false, trustedEnvironment: true, workflowModifiedByUntrustedPr: false });
    expect(clean.trustworthy).toBe(true);
  });
});

describe('decideComment', () => {
  it('CI 已清楚显示且无增量价值 → 不评论', () => {
    const d = decideComment({ diagnostics: [{ severity: 'error', message: 'x' }], ciAlreadyShowsError: true });
    expect(d.shouldComment).toBe(false);
    expect(d.reasons[0]).toContain('不复述');
  });
  it('有根因/可验证修复 → 评论', () => {
    const d = decideComment({
      diagnostics: [{ severity: 'error', message: 'x', onChangedCode: true }],
      ciAlreadyShowsError: true,
      rootCause: { summary: '空指针', causingChange: 'PR 引入的 null 分支', sameRootCauseGroups: [['j1', 'j2']], verifiableFix: '加空判断', codeLocations: [], confidence: 0.8 },
    });
    expect(d.shouldComment).toBe(true);
    expect(d.valueAdds).toContain('verifiable fix');
    expect(d.valueAdds).toContain('grouped same-root-cause failures');
  });
});

describe('analyzeRootCause', () => {
  it('经终结工具产出根因与分组', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(
        faux.toolCall('submit_root_cause', {
          summary: 'null deref in parse()',
          causingChange: 'PR 移除了 guard',
          sameRootCauseGroups: [['j1', 'j2']],
          verifiableFix: '恢复 guard 并加测试',
          codeLocations: [{ file: 'src/parse.ts', line: 12 }],
          confidence: 1.4,
        }),
      ),
    ]);
    const jobs: FailedJob[] = [
      { jobId: 'j1', name: 'build', conclusion: 'failure', diagnostics: [{ severity: 'error', message: 'TypeError', file: 'src/parse.ts', line: 12, onChangedCode: true }] },
      { jobId: 'j2', name: 'test', conclusion: 'failure', diagnostics: [] },
    ];
    const rc = await analyzeRootCause(jobs, { model: faux.model, streamFn: faux.streamFn, changeSummary: 'refactor parse' });
    expect(rc.summary).toContain('null deref');
    expect(rc.sameRootCauseGroups).toEqual([['j1', 'j2']]);
    expect(rc.confidence).toBe(1); // clamp
    expect(rc.codeLocations[0]).toMatchObject({ file: 'src/parse.ts', line: 12 });
  });
});
