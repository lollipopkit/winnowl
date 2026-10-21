import { describe, expect, it, vi } from 'vitest';
import { scanDependencyVulnerabilities } from '../src/index.js';

/** osv-scanner JSON: one npm vulnerability with a fixed version. */
const OSV_JSON = JSON.stringify({
  results: [
    {
      packages: [
        {
          package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
          vulnerabilities: [
            {
              id: 'GHSA-p6mc-m468-83gw',
              summary: 'Prototype Pollution in lodash',
              database_specific: { severity: 'HIGH' },
              references: [{ url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw' }],
              affected: [{ ranges: [{ events: [{ fixed: '4.17.19' }] }] }],
            },
          ],
        },
      ],
    },
  ],
});

describe('scanDependencyVulnerabilities — osv-scanner 执行侧(§联网证据)', () => {
  it('无依赖 manifest 变更 → 跳过,不起进程', async () => {
    const exec = vi.fn();
    const evidence = await scanDependencyVulnerabilities({ headDir: '/w', changedFiles: ['src/a.ts', 'README.md'], exec });
    expect(evidence).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it('有依赖变更 + 漏洞 → 渲染证据块', async () => {
    // npm manifest → npm audit runs too (empty here).
    const exec = vi.fn().mockImplementation((bin: string) => Promise.resolve(bin === 'npm' ? '{"vulnerabilities":{}}' : OSV_JSON));
    const evidence = await scanDependencyVulnerabilities({ headDir: '/w', changedFiles: ['package-lock.json'], exec });
    expect(exec).toHaveBeenCalledWith('osv-scanner', ['scan', '--recursive', '--format', 'json', '.'], { cwd: '/w', timeoutMs: 120_000 });
    expect(evidence?.evidence).toContain('GHSA-p6mc-m468-83gw');
    expect(evidence?.evidence).toContain('lodash@4.17.15');
    expect(evidence?.evidence).toContain('fix: 4.17.19');
    expect(evidence?.evidence).toContain('[high]');
    expect(evidence?.vulnerabilities[0]).toMatchObject({ package: 'lodash', advisoryId: 'GHSA-p6mc-m468-83gw', severity: 'high' });
    expect(evidence?.totalCount).toBe(1);
  });

  it('npm 生态:npm audit 补充源合并(osv 未含的漏洞并入,去重)', async () => {
    const NPM_AUDIT = JSON.stringify({
      vulnerabilities: {
        axios: { severity: 'high', via: [{ title: 'SSRF in axios', url: 'https://github.com/advisories/GHSA-axios-1234', severity: 'high', name: 'axios' }], fixAvailable: { version: '1.2.3' } },
      },
    });
    const exec = vi.fn().mockImplementation((bin: string) => Promise.resolve(bin === 'npm' ? NPM_AUDIT : OSV_JSON));
    const evidence = await scanDependencyVulnerabilities({ headDir: '/w', changedFiles: ['package-lock.json'], exec });
    // lodash from osv and axios from npm audit are merged.
    expect(evidence?.evidence).toContain('GHSA-p6mc-m468-83gw'); // osv
    expect(evidence?.evidence).toContain('GHSA-axios-1234'); // npm audit
    expect(exec).toHaveBeenCalledWith('npm', ['audit', '--json', '--package-lock-only'], { cwd: '/w', timeoutMs: 120_000 });
  });

  it('Pub:pubspec.lock 变更 → 起 osv-scanner(不跑 npm audit),manifestPath 归一为相对路径', async () => {
    const PUB_OSV = JSON.stringify({
      results: [
        {
          source: { path: '/w/app/pubspec.lock', type: 'lockfile' },
          packages: [
            {
              package: { name: 'http', version: '0.12.2', ecosystem: 'Pub' },
              vulnerabilities: [
                {
                  id: 'GHSA-4rgh-jx4f-qfcq',
                  summary: 'http before 0.13.3 vulnerable to header injection',
                  database_specific: { severity: 'MODERATE' },
                  affected: [{ package: { ecosystem: 'Pub', name: 'http' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '0.13.3' }] }] }],
                },
              ],
            },
          ],
        },
      ],
    });
    const exec = vi.fn().mockResolvedValue(PUB_OSV);
    const onScan = vi.fn();
    const scan = await scanDependencyVulnerabilities({ headDir: '/w', changedFiles: ['app/pubspec.lock', 'app/lib/main.dart'], exec, onScan });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('osv-scanner', ['scan', '--recursive', '--format', 'json', '.'], { cwd: '/w', timeoutMs: 120_000 });
    expect(onScan).toHaveBeenCalledWith({ manifestCount: 1, vulnerabilityCount: 1, mode: 'changed' });
    expect(scan?.vulnerabilities).toEqual([
      expect.objectContaining({ ecosystem: 'Pub', package: 'http', installedVersion: '0.12.2', severity: 'medium', fixedVersion: '0.13.3', manifestPath: 'app/pubspec.lock' }),
    ]);
    expect(scan?.evidence).toContain('http@0.12.2');
  });

  it('Pub:仅 pubspec.yaml 变更也触发扫描', async () => {
    const exec = vi.fn().mockResolvedValue(JSON.stringify({ results: [] }));
    await scanDependencyVulnerabilities({ headDir: '/w', changedFiles: ['pubspec.yaml'], exec });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('有依赖变更但无漏洞 → undefined(不注入空证据)', async () => {
    const exec = vi.fn().mockResolvedValue(JSON.stringify({ results: [] }));
    const evidence = await scanDependencyVulnerabilities({ headDir: '/w', changedFiles: ['go.mod'], exec });
    expect(evidence).toBeUndefined();
  });

  it('非 JSON 输出 → undefined(容错,不抛)', async () => {
    const exec = vi.fn().mockResolvedValue('No vulnerabilities found');
    const evidence = await scanDependencyVulnerabilities({ headDir: '/w', changedFiles: ['Cargo.lock'], exec });
    expect(evidence).toBeUndefined();
  });

  it('超过上限 → 按严重度降序取前 N + 显式标注剩余(不静默丢)', async () => {
    const mk = (i: number, sev: string) => ({
      package: { name: `pkg${i}`, version: '1.0.0', ecosystem: 'npm' },
      vulnerabilities: [{ id: `ADV-${sev}-${i}`, summary: 's', database_specific: { severity: sev.toUpperCase() }, affected: [] }],
    });
    // 2 low + 2 critical, max=2 → only the criticals remain.
    const json = JSON.stringify({ results: [{ packages: [mk(1, 'low'), mk(2, 'critical'), mk(3, 'low'), mk(4, 'critical')] }] });
    const exec = vi.fn().mockResolvedValue(json);
    const evidence = await scanDependencyVulnerabilities({ headDir: '/w', changedFiles: ['package-lock.json'], exec, maxAdvisories: 2 });
    expect(evidence?.evidence).toContain('ADV-critical-2');
    expect(evidence?.evidence).toContain('ADV-critical-4');
    expect(evidence?.evidence).not.toContain('ADV-low');
    expect(evidence?.evidence).toContain('2 more');
    expect(evidence?.evidence).toContain('4 total');
    expect(evidence?.vulnerabilities).toHaveLength(2); // only the two criticals after truncation
    expect(evidence?.totalCount).toBe(4);
  });

  it('bin 可注入(测试/自定义路径)', async () => {
    const exec = vi.fn().mockResolvedValue(JSON.stringify({ results: [] }));
    await scanDependencyVulnerabilities({ headDir: '/w', changedFiles: ['package-lock.json'], bin: '/custom/osv', exec });
    expect(exec).toHaveBeenCalledWith('/custom/osv', expect.anything(), expect.objectContaining({ cwd: '/w' }));
  });
});
