import { describe, expect, it } from 'vitest';
import { lockfileEcosystem, parseVersion, resolvedVersion, satisfies } from '../src/index.js';

describe('satisfies(version, range)', () => {
  const cases: [string, string, boolean | undefined][] = [
    ['1.5.2', '>=1.0.0 <2.0.0', true],
    ['2.0.0', '>=1.0.0 <2.0.0', false],
    ['2.0.0', '>= 2.0', true],
    ['1.9.9', '<2.0.0', true],
    ['3.47.1', '>=3.47.0', true],
    ['1.2.9', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.4.9', '~=1.4.2', true],
    ['1.5.0', '~=1.4.2', false],
    ['2.1.5', '2.1.x', true],
    ['2.2.0', '2.1.x', false],
    ['7.0.0', '1.* || 7.*', true],
    ['5.0.0', '*', true],
    ['1.0.0', '1.0.0 - 1.2.0', true],
    ['1.3.0', '1.0.0 - 1.2.0', false],
    ['1.2.0', '>=1.0,<2.0', true],
    ['1.2.0', '==1.2', true],
    ['1.2.0', '!=1.2.0', false],
    ['v1.21.0', '>=v1.20.0', true],
    ['2.0.0-beta.1', '>=2.0.0', true],
    ['1.0.0', 'before the 2.0 rewrite', undefined],
    ['1.0.0', 'latest', undefined],
    ['1.0.0', '>=1.0.0 ||', undefined],
    ['abc', '>=1.0.0', undefined],
  ];
  it.each(cases)('%s in %s → %s', (v, r, expected) => {
    expect(satisfies(v, r)).toBe(expected);
  });

  it('parses dotted numeric versions, ignoring v prefixes and pre-release suffixes', () => {
    expect(parseVersion('v1.21.3')).toEqual([1, 21, 3]);
    expect(parseVersion('2.0.0-rc.1+build')).toEqual([2, 0, 0]);
    expect(parseVersion('next')).toBeUndefined();
  });
});

describe('resolvedVersion(eco, name, files)', () => {
  it('reads the resolved version from each lockfile format', () => {
    const cases: [Parameters<typeof resolvedVersion>[0], string, string, string, string][] = [
      ['npm', 'react', 'package-lock.json', JSON.stringify({ packages: { 'node_modules/react': { version: '19.1.0' }, 'node_modules/a/node_modules/react': { version: '17.0.0' } } }), '19.1.0'],
      ['npm', 'react', 'package-lock.json', JSON.stringify({ dependencies: { react: { version: '16.14.0' } } }), '16.14.0'],
      ['npm', '@scope/pkg', 'pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n\n  '@scope/pkg@2.3.4':\n    resolution: {}\n", '2.3.4'],
      ['npm', 'lodash', 'pnpm-lock.yaml', 'lockfileVersion: 5.4\npackages:\n  /lodash/4.17.21:\n    resolution: {}\n', '4.17.21'],
      ['npm', 'lodash', 'yarn.lock', 'lodash@^4.17.0, lodash@^4.17.21:\n  version "4.17.21"\n  resolved "x"\n', '4.17.21'],
      ['npm', 'lodash', 'yarn.lock', '"lodash@npm:^4.17.0":\n  version: 4.17.21\n  resolution: "x"\n', '4.17.21'],
      ['pub', 'http', 'pubspec.lock', 'packages:\n  http:\n    dependency: "direct main"\n    description:\n      name: http\n      url: "https://pub.dev"\n    source: hosted\n    version: "1.2.2"\n', '1.2.2'],
      ['cargo', 'serde', 'Cargo.lock', '[[package]]\nname = "serde"\nversion = "1.0.210"\n\n[[package]]\nname = "syn"\nversion = "2.0.0"\n', '1.0.210'],
      ['pypi', 'Django', 'poetry.lock', '[[package]]\nname = "django"\nversion = "5.1.2"\n', '5.1.2'],
      ['composer', 'laravel/framework', 'composer.lock', JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v11.2.0' }] }), '11.2.0'],
      ['rubygems', 'rails', 'Gemfile.lock', 'GEM\n  specs:\n    rails (7.1.3)\n      actionpack (= 7.1.3)\n', '7.1.3'],
    ];
    for (const [eco, name, file, text, expected] of cases) {
      expect(resolvedVersion(eco, name, [{ path: `sub/${file}`, text }]), `${file}:${name}`).toBe(expected);
    }
  });

  it('treats SDK packages in pubspec.lock (pinned as 0.0.0) as unknown', () => {
    const lock = 'packages:\n  flutter:\n    dependency: "direct main"\n    description: flutter\n    source: sdk\n    version: "0.0.0"\n  http:\n    dependency: "direct main"\n    source: hosted\n    version: "1.2.2"\nsdks:\n  flutter: ">=3.24.0"\n';
    expect(resolvedVersion('pub', 'flutter', [{ path: 'pubspec.lock', text: lock }])).toBeUndefined();
    expect(resolvedVersion('pub', 'http', [{ path: 'pubspec.lock', text: lock }])).toBe('1.2.2');
  });

  it('falls back to exact pins in manifests, never to ranges', () => {
    expect(resolvedVersion('go', 'github.com/gin-gonic/gin', [{ path: 'go.mod', text: 'module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n' }])).toBe('v1.10.0');
    expect(resolvedVersion('npm', 'react', [{ path: 'package.json', text: '{"dependencies":{"react":"19.0.0"}}' }])).toBe('19.0.0');
    expect(resolvedVersion('npm', 'react', [{ path: 'package.json', text: '{"dependencies":{"react":"^19.0.0"}}' }])).toBeUndefined();
    expect(resolvedVersion('pypi', 'Flask', [{ path: 'requirements.txt', text: 'flask[async]==3.0.3  # pinned\nrequests>=2\n' }])).toBe('3.0.3');
    expect(resolvedVersion('pub', 'http', [{ path: 'pubspec.yaml', text: 'dependencies:\n  http: 1.2.0\n' }])).toBe('1.2.0');
  });

  it('is unknown when two lockfiles disagree (e.g. a monorepo with two versions)', () => {
    const lock = (v: string) => ({ path: `${v}/package-lock.json`, text: JSON.stringify({ packages: { 'node_modules/react': { version: v } } }) });
    expect(resolvedVersion('npm', 'react', [lock('18.3.1'), lock('19.1.0')])).toBeUndefined();
    expect(lockfileEcosystem('Cargo.lock')).toBe('cargo');
    expect(lockfileEcosystem('Cargo.toml')).toBeUndefined();
  });
});
