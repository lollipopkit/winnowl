import { describe, expect, it } from 'vitest';
import { factsWithLongDetail, formatEcosystemFacts, manifestEcosystem, normalizeFactSources, selectFactsForManifests, type EcosystemFact } from '../src/index.js';

const fact = (over: Partial<EcosystemFact>): EcosystemFact => ({
  id: 'f',
  ecosystem: 'pub',
  subject: 'material_ui',
  claim: 'c',
  sources: ['https://pub.dev/packages/material_ui'],
  status: 'approved',
  origin: 'review',
  observedAt: new Date('2026-09-29T00:00:00Z'),
  createdAt: new Date('2026-09-29T00:00:00Z'),
  ...over,
});

describe('生态知识:manifest 匹配与注入文本', () => {
  it('manifestEcosystem 认出各生态的清单文件(精确 / 前缀 / 后缀)', () => {
    expect(manifestEcosystem('pubspec.yaml')).toBe('pub');
    expect(manifestEcosystem('requirements-dev.txt')).toBe('pypi');
    expect(manifestEcosystem('App.csproj')).toBe('nuget');
    expect(manifestEcosystem('foo.gemspec')).toBe('rubygems');
    expect(manifestEcosystem('README.md')).toBeUndefined();
  });

  it('按同生态 manifest 里的完整名字匹配;前后缀不算', () => {
    const manifests = [
      { path: 'app/pubspec.yaml', text: 'environment:\n  flutter: ">=3.47.0"\ndependencies:\n  material_ui: ^1.5.0\n  flutter_lints: ^6.0.0\n' },
      { path: 'package.json', text: '{"dependencies":{"react":"^19.0.0"}}' },
    ];
    const facts = [
      fact({ id: 'a', subject: 'material_ui' }),
      fact({ id: 'b', subject: 'flutter' }),
      fact({ id: 'c', subject: 'lints' }), // only appears as a suffix of flutter_lints
      fact({ id: 'd', subject: 'react' }), // in the npm manifest, not the pub one
      fact({ id: 'e', ecosystem: 'npm', subject: 'react' }),
      fact({ id: 'f', ecosystem: 'other', subject: 'flutter' }),
      fact({ id: 'g', ecosystem: 'maven', subject: 'com.google.guava:guava' }), // no maven manifest
    ];
    expect(selectFactsForManifests(facts, manifests).map((f) => f.id)).toEqual(['a', 'b', 'e', 'f']);
  });

  it('maven 的 group:artifact 也按 artifact 匹配', () => {
    const facts = [fact({ ecosystem: 'maven', subject: 'com.google.guava:guava' })];
    expect(selectFactsForManifests(facts, [{ path: 'build.gradle', text: "implementation 'guava'" }])).toHaveLength(1);
  });

  it('注入文本带版本范围、细节、来源与核实日期;空集 → undefined', () => {
    const text = formatEcosystemFacts([fact({ versions: '>=3.47', detail: 'step 1\nstep 2' })]);
    expect(text).toBe('- [pub] material_ui (>=3.47; repo version unknown): c\n  step 1\n  step 2\n  sources: https://pub.dev/packages/material_ui (as of 2026-09-29)');
    expect(formatEcosystemFacts([{ ...fact({ versions: '<2.0.0' }), repoVersion: '1.5.0' }])).toContain('(<2.0.0; repo uses 1.5.0)');
    expect(formatEcosystemFacts([])).toBeUndefined();
  });

  it('来源只收 http(s) URL,去重限量', () => {
    expect(normalizeFactSources(['https://a.dev/x', ' https://a.dev/x ', 'ftp://b', 'javascript:alert(1)', 'http://c.dev'])).toEqual(['https://a.dev/x', 'http://c.dev']);
    expect(normalizeFactSources(Array.from({ length: 9 }, (_, i) => `https://s.dev/${i}`))).toHaveLength(5);
  });

  it('drops a fact only when the repo version is known, the range parses, and they do not overlap', () => {
    const files = [
      { path: 'pubspec.yaml', text: 'dependencies:\n  material_ui: ^1.5.0\n  http: any\n' },
      { path: 'pubspec.lock', text: 'packages:\n  material_ui:\n    dependency: "direct main"\n    description:\n      name: material_ui\n    source: hosted\n    version: "1.5.2"\n' },
    ];
    const facts = [
      fact({ id: 'in-range', versions: '>=1.0.0 <2.0.0' }),
      fact({ id: 'out-of-range', versions: '>=2.0.0' }),
      fact({ id: 'prose-range', versions: 'before the 2.0 rewrite' }),
      fact({ id: 'no-range' }),
      fact({ id: 'unknown-version', subject: 'http', versions: '<1.0.0' }),
    ];
    const picked = selectFactsForManifests(facts, files);
    expect(picked.map((f) => f.id)).toEqual(['in-range', 'prose-range', 'no-range', 'unknown-version']);
    expect(picked.find((f) => f.id === 'in-range')?.repoVersion).toBe('1.5.2');
    expect(picked.find((f) => f.id === 'unknown-version')?.repoVersion).toBeUndefined();
  });

  it('lockfiles decide versions but do not make transitive dependencies match', () => {
    const files = [
      { path: 'package.json', text: '{"dependencies":{"react":"^19.0.0"}}' },
      { path: 'package-lock.json', text: JSON.stringify({ packages: { 'node_modules/react': { version: '19.1.0' }, 'node_modules/scheduler': { version: '0.26.0' } } }) },
    ];
    const picked = selectFactsForManifests([fact({ id: 'transitive', ecosystem: 'npm', subject: 'scheduler' }), fact({ id: 'direct', ecosystem: 'npm', subject: 'react', versions: '^19' })], files);
    expect(picked.map((f) => f.id)).toEqual(['direct']);
    expect(picked[0]?.repoVersion).toBe('19.1.0');
  });

  it('long details become a knowledge_read pointer instead of being cut', () => {
    const long = fact({ id: 'long-1', detail: 'x'.repeat(301) });
    const text = formatEcosystemFacts([long, fact({ id: 'short-1', detail: 'short' })])!;
    expect(text).toContain('details: [read: knowledge_read long-1]');
    expect(text).not.toContain('x'.repeat(301));
    expect(text).toContain('\n  short\n');
    expect(factsWithLongDetail([long, fact({ id: 'short-1', detail: 'short' })]).map((f) => f.id)).toEqual(['long-1']);
  });
});
