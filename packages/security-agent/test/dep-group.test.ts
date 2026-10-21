import { describe, expect, it } from 'vitest';
import { applicableFix, groupVulnerabilities, parseOsvScanner } from '../src/index.js';

describe('dependency advisories', () => {
  it('picks the fix in the installed version line, not the first range listed', () => {
    expect(applicableFix(['6.28.0', '7.29.0'], '7.28.0')).toBe('7.29.0');
    expect(applicableFix(['6.28.0', '7.29.0'], '6.1.0')).toBe('6.28.0');
    expect(applicableFix(['6.28.0', '7.29.0'], undefined)).toBe('7.29.0');
    const osv = {
      results: [
        {
          source: { path: 'pnpm-lock.yaml' },
          packages: [
            {
              package: { name: 'undici', ecosystem: 'npm', version: '7.28.0' },
              vulnerabilities: [
                {
                  id: 'GHSA-a',
                  database_specific: { severity: 'MODERATE' },
                  affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '6.28.0' }] }, { events: [{ introduced: '7.0.0' }, { fixed: '7.29.0' }] }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(parseOsvScanner(osv)[0]?.fixedVersion).toBe('7.29.0');
  });

  it('merges advisories of one package version into one entry with the highest severity and a fix for all', () => {
    const base = { ecosystem: 'npm', package: 'undici', installedVersion: '7.28.0', manifestPath: 'pnpm-lock.yaml' };
    const groups = groupVulnerabilities([
      { ...base, advisoryId: 'GHSA-1', severity: 'medium', title: 'a', fixedVersion: '7.29.0' },
      { ...base, advisoryId: 'GHSA-2', severity: 'high', title: 'b', fixedVersion: '7.30.1' },
      { ...base, advisoryId: 'GHSA-2', severity: 'high', title: 'b', fixedVersion: '7.30.1' },
      { ...base, package: 'sharp', installedVersion: '0.35.2', advisoryId: 'GHSA-3', severity: 'high', title: 'c', fixedVersion: '0.35.4' },
    ]);
    expect(groups).toHaveLength(2);
    const undici = groups.find((g) => g.package === 'undici')!;
    expect(undici.severity).toBe('high');
    expect(undici.advisories.map((a) => a.id)).toEqual(['GHSA-2', 'GHSA-1']);
    expect(undici.fixedVersion).toBe('7.30.1');
    // One advisory without a fix → the group has none.
    expect(
      groupVulnerabilities([
        { ...base, advisoryId: 'X', severity: 'low', title: 'x', fixedVersion: '7.29.0' },
        { ...base, advisoryId: 'Y', severity: 'low', title: 'y' },
      ])[0]!.fixedVersion,
    ).toBeUndefined();
  });
});
