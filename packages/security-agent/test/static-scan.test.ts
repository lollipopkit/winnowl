import { describe, expect, it } from 'vitest';
import { parseGitleaks, parseSemgrep, renderStaticEvidence, scanStaticRisks } from '../src/index.js';

describe('parseSemgrep(§35 确定性扫描器证据)', () => {
  it('提取 rule/severity/位置/message,路径剥离工作区前缀', () => {
    const hits = parseSemgrep(
      {
        results: [
          {
            check_id: 'python.lang.security.audit.eval-detected',
            path: '/work/repo/app/main.py',
            start: { line: 42 },
            extra: { severity: 'ERROR', message: 'Detected use of eval()' },
          },
          { check_id: 'js.warn', path: '/work/repo/a.js', start: { line: 1 }, extra: { severity: 'WARNING', message: 'w' } },
          { check_id: 'js.info', path: '/work/repo/b.js', extra: { severity: 'INFO', message: 'i' } },
        ],
      },
      '/work/repo',
    );
    expect(hits).toEqual([
      { scanner: 'semgrep', ruleId: 'python.lang.security.audit.eval-detected', severity: 'high', path: 'app/main.py', line: 42, message: 'Detected use of eval()' },
      { scanner: 'semgrep', ruleId: 'js.warn', severity: 'medium', path: 'a.js', line: 1, message: 'w' },
      { scanner: 'semgrep', ruleId: 'js.info', severity: 'low', path: 'b.js', message: 'i' },
    ]);
  });

  it('形状不符/缺字段的条目跳过,不抛', () => {
    expect(parseSemgrep({ results: [{ path: 'x' }, { check_id: 'y' }, 'junk'] })).toEqual([]);
    expect(parseSemgrep(null)).toEqual([]);
    expect(parseSemgrep({ results: 'not-array' })).toEqual([]);
  });
});

describe('parseGitleaks(§35;密钥绝不回显)', () => {
  const raw = [
    {
      RuleID: 'aws-access-token',
      Description: 'AWS Access Token',
      File: '/work/repo/config/prod.env',
      StartLine: 7,
      Secret: 'AKIAIOSFODNN7EXAMPLE',
      Match: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
      Line: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
    },
  ];

  it('只保留规则/位置,严重度恒 critical', () => {
    expect(parseGitleaks(raw, '/work/repo')).toEqual([
      { scanner: 'gitleaks', ruleId: 'aws-access-token', severity: 'critical', path: 'config/prod.env', line: 7, message: 'AWS Access Token' },
    ]);
  });

  it('明文密钥不出现在解析结果与渲染证据的任何位置', () => {
    const hits = parseGitleaks(raw, '/work/repo');
    const serialized = JSON.stringify(hits) + renderStaticEvidence(hits);
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(serialized).not.toContain('AWS_KEY=');
  });
});

describe('renderStaticEvidence', () => {
  it('空集 → 空串;非空带「线索非结论」口径与截断提示', () => {
    expect(renderStaticEvidence([])).toBe('');
    const text = renderStaticEvidence(
      [{ scanner: 'semgrep', ruleId: 'r', severity: 'high', path: 'a.ts', line: 3, message: 'm' }],
      12,
    );
    expect(text).toContain('a.ts:3');
    expect(text).toContain('evidence only');
    expect(text).toContain('11 more');
  });
});

describe('scanStaticRisks(执行侧,注入 exec)', () => {
  const semgrepJson = JSON.stringify({
    results: [{ check_id: 'r1', path: 'a.py', start: { line: 1 }, extra: { severity: 'ERROR', message: 'eval' } }],
  });
  const gitleaksJson = JSON.stringify([{ RuleID: 'generic-api-key', Description: 'Generic API Key', File: 'b.env', StartLine: 2, Secret: 'sk-live-topsecret' }]);

  it('两个扫描器都有命中 → 合并、按严重度降序、gitleaks 在前', async () => {
    const res = await scanStaticRisks({
      dir: '/work',
      exec: async (bin) => (bin === 'semgrep' ? semgrepJson : ''),
      reportPath: '/tmp/probe.json',
      readReport: async () => gitleaksJson,
    });
    expect(res?.findings.map((f) => f.scanner)).toEqual(['gitleaks', 'semgrep']);
    expect(res?.totalCount).toBe(2);
    expect(res?.evidence).not.toContain('sk-live-topsecret');
  });

  it('单个扫描器缺失(ENOENT)→ 另一个照常出证据,并回报 failed', async () => {
    const seen: { scanner: string; count: number; failed?: string }[] = [];
    const res = await scanStaticRisks({
      dir: '/work',
      onScan: (i) => seen.push(i),
      exec: async (bin) => {
        if (bin === 'semgrep') throw new Error('spawn semgrep ENOENT');
        return '';
      },
      reportPath: '/tmp/probe.json',
      readReport: async () => gitleaksJson,
    });
    expect(res?.findings).toHaveLength(1);
    expect(seen.find((s) => s.scanner === 'semgrep')?.failed).toContain('ENOENT');
    expect(seen.find((s) => s.scanner === 'gitleaks')?.count).toBe(1);
  });

  it('两个都不可用 → undefined(不抛,security_scan 继续走 agent 读码)', async () => {
    const res = await scanStaticRisks({
      dir: '/work',
      exec: async () => { throw new Error('not installed'); },
      reportPath: '/tmp/probe.json',
      readReport: async () => { throw new Error('no report'); },
    });
    expect(res).toBeUndefined();
  });

  it('gitleaks 报告走**临时文件**而非 /dev/stdout(2026-07-29 live:容器内 /dev/stdout 直接 FTL,扫了却拿不到结果)', async () => {
    const seen: string[][] = [];
    await scanStaticRisks({
      dir: '/work',
      exec: async (bin, args) => { seen.push([bin, ...args]); return ''; },
      reportPath: '/tmp/probe.json',
      readReport: async () => '[]',
    });
    const gl = seen.find((a) => a[0] === 'gitleaks')!;
    expect(gl).toContain('--report-path');
    expect(gl[gl.indexOf('--report-path') + 1]).toBe('/tmp/probe.json');
    expect(gl).not.toContain('/dev/stdout');
  });

  it('报告为空/空数组 → 零命中而非失败(gitleaks 无命中时的正常输出)', async () => {
    const seen: { scanner: string; failed?: string }[] = [];
    await scanStaticRisks({
      dir: '/work',
      onScan: (i) => seen.push(i),
      exec: async () => '',
      reportPath: '/tmp/probe.json',
      readReport: async () => '',
    });
    expect(seen.find((s) => s.scanner === 'gitleaks')?.failed).toBeUndefined();
  });

  it('超上限按严重度截断,总数如实带出', async () => {
    const many = JSON.stringify({
      results: Array.from({ length: 5 }, (_, i) => ({
        check_id: `r${i}`,
        path: `f${i}.py`,
        start: { line: 1 },
        extra: { severity: i === 0 ? 'ERROR' : 'INFO', message: 'm' },
      })),
    });
    const res = await scanStaticRisks({
      dir: '/work',
      maxFindings: 2,
      exec: async (bin) => (bin === 'semgrep' ? many : ''),
      reportPath: '/tmp/probe.json',
      readReport: async () => '[]',
    });
    expect(res?.findings).toHaveLength(2);
    expect(res?.findings[0]?.severity).toBe('high'); // highest severity kept first
    expect(res?.totalCount).toBe(5);
    expect(res?.evidence).toContain('3 more');
  });
});
