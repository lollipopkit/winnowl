import { describe, expect, it } from 'vitest';
import {
  detectDependencyManifests,
  parseNpmAudit,
  parseOsvScanner,
  renderDependencyEvidence,
} from '../src/index.js';

describe('detectDependencyManifests — 依赖 manifest 检测(§联网证据)', () => {
  it('按生态 + lock 优先归类,非 manifest 忽略', () => {
    const got = detectDependencyManifests(['apps/web/package.json', 'apps/web/package-lock.json', 'go.mod', 'src/index.ts', 'requirements.txt', 'Cargo.toml']);
    expect(got).toEqual([
      { ecosystem: 'npm', path: 'apps/web/package.json', kind: 'manifest' },
      { ecosystem: 'npm', path: 'apps/web/package-lock.json', kind: 'lockfile' },
      { ecosystem: 'go', path: 'go.mod', kind: 'manifest' },
      { ecosystem: 'pip', path: 'requirements.txt', kind: 'lockfile' },
      { ecosystem: 'cargo', path: 'Cargo.toml', kind: 'manifest' },
    ]);
  });
  it('Pub(Dart/Flutter):pubspec.lock 为 lockfile,pubspec.yaml 为 manifest', () => {
    expect(detectDependencyManifests(['app/pubspec.yaml', 'app/pubspec.lock', 'lib/main.dart', 'pubspec.yaml.bak'])).toEqual([
      { ecosystem: 'pub', path: 'app/pubspec.yaml', kind: 'manifest' },
      { ecosystem: 'pub', path: 'app/pubspec.lock', kind: 'lockfile' },
    ]);
  });
  it('无依赖变更 → 空', () => {
    expect(detectDependencyManifests(['src/a.ts', 'README.md'])).toEqual([]);
  });
});

describe('parseNpmAudit — npm audit --json(v7+)', () => {
  it('提取 advisory(title/url/severity/fix),moderate→medium', () => {
    const json = {
      vulnerabilities: {
        lodash: {
          name: 'lodash',
          severity: 'high',
          via: [{ source: 1065, name: 'lodash', title: 'Prototype Pollution', url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw', severity: 'high', range: '<4.17.19' }],
          range: '<4.17.19',
          fixAvailable: { name: 'lodash', version: '4.17.21' },
        },
        minimist: {
          name: 'minimist',
          severity: 'moderate',
          via: [{ source: 1179, name: 'minimist', title: 'Prototype Pollution in minimist', url: 'https://github.com/advisories/GHSA-vh95-rmgr-6w4m', severity: 'moderate' }],
          fixAvailable: true,
        },
      },
    };
    const vulns = parseNpmAudit(json);
    expect(vulns).toHaveLength(2);
    const lodash = vulns.find((v) => v.package === 'lodash')!;
    expect(lodash.severity).toBe('high');
    expect(lodash.title).toBe('Prototype Pollution');
    expect(lodash.url).toContain('GHSA-p6mc');
    expect(lodash.fixedVersion).toBe('4.17.21');
    expect(vulns.find((v) => v.package === 'minimist')!.severity).toBe('medium'); // moderate→medium
  });
  it('结构不符/空 → []', () => {
    expect(parseNpmAudit({})).toEqual([]);
    expect(parseNpmAudit(null)).toEqual([]);
    expect(parseNpmAudit({ vulnerabilities: {} })).toEqual([]);
  });
});

describe('parseOsvScanner — osv-scanner json', () => {
  it('提取 id/summary/severity/installedVersion/fixedVersion', () => {
    const json = {
      results: [
        {
          source: { path: 'go.mod', type: 'lockfile' },
          packages: [
            {
              package: { name: 'golang.org/x/net', version: '0.7.0', ecosystem: 'Go' },
              vulnerabilities: [
                {
                  id: 'GHSA-2wrh-6pvc-2jm9',
                  summary: 'HTTP/2 rapid reset',
                  database_specific: { severity: 'HIGH' },
                  references: [{ type: 'WEB', url: 'https://osv.dev/GHSA-2wrh-6pvc-2jm9' }],
                  affected: [{ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.17.0' }] }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const vulns = parseOsvScanner(json);
    expect(vulns).toHaveLength(1);
    const v = vulns[0]!;
    expect(v.advisoryId).toBe('GHSA-2wrh-6pvc-2jm9');
    expect(v.package).toBe('golang.org/x/net');
    expect(v.installedVersion).toBe('0.7.0');
    expect(v.severity).toBe('high');
    expect(v.fixedVersion).toBe('0.17.0');
    expect(v.title).toBe('HTTP/2 rapid reset');
  });
  it('Pub 生态(osv-scanner 读 pubspec.lock 的输出)', () => {
    const json = {
      results: [
        {
          source: { path: '/w/app/pubspec.lock', type: 'lockfile' },
          packages: [
            {
              package: { name: 'http', version: '0.12.2', ecosystem: 'Pub' },
              vulnerabilities: [
                {
                  id: 'GHSA-4rgh-jx4f-qfcq',
                  aliases: ['CVE-2020-35669'],
                  summary: 'http before 0.13.3 vulnerable to header injection',
                  database_specific: { severity: 'MODERATE' },
                  references: [{ type: 'ADVISORY', url: 'https://nvd.nist.gov/vuln/detail/CVE-2020-35669' }],
                  affected: [
                    {
                      package: { ecosystem: 'Pub', name: 'http' },
                      ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '0.13.3' }] }],
                    },
                  ],
                },
              ],
              groups: [{ ids: ['GHSA-4rgh-jx4f-qfcq'] }],
            },
          ],
        },
      ],
    };
    expect(parseOsvScanner(json)).toEqual([
      {
        ecosystem: 'Pub',
        package: 'http',
        installedVersion: '0.12.2',
        severity: 'medium',
        advisoryId: 'GHSA-4rgh-jx4f-qfcq',
        title: 'http before 0.13.3 vulnerable to header injection',
        url: 'https://nvd.nist.gov/vuln/detail/CVE-2020-35669',
        fixedVersion: '0.13.3',
        manifestPath: '/w/app/pubspec.lock',
      },
    ]);
  });
  it('结构不符 → []', () => {
    expect(parseOsvScanner({ results: [] })).toEqual([]);
    expect(parseOsvScanner(undefined)).toEqual([]);
  });
});

describe('renderDependencyEvidence', () => {
  it('证据块可读', () => {
    expect(renderDependencyEvidence([])).toContain('No known dependency vulnerabilities');
    expect(renderDependencyEvidence([{ ecosystem: 'npm', package: 'lodash', severity: 'high', advisoryId: 'GHSA-x', title: 'Proto' }])).toContain('lodash');
  });
});
