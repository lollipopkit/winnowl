import { describe, expect, it } from 'vitest';
import {
  attributeCrossRepoFinding,
  detectCrossRepoTriggers,
  evaluateCrossRepoAccess,
  type RepositoryRelationship,
  matchRelationships,
  parseManifest,
} from '../src/index.js';

const REL: RepositoryRelationship = {
  id: 'r1',
  sourceRepositoryId: 'src',
  targetRepositoryId: 'tgt',
  kind: 'api-provider',
  enabled: true,
  status: 'active',
};

describe('detectCrossRepoTriggers', () => {
  it('识别 openapi/proto/graphql/db 契约面', () => {
    const t = detectCrossRepoTriggers([
      'api/openapi.yaml',
      'proto/user.proto',
      'schema.graphql',
      'migrations/0001_init.sql',
      'src/app.ts', // not a contract surface
    ]);
    const kinds = t.map((x) => x.kind).sort();
    expect(kinds).toEqual(['database-contract', 'graphql', 'openapi', 'protobuf']);
    expect(t.find((x) => x.kind === 'protobuf')?.files).toEqual(['proto/user.proto']);
  });

  it('无契约面变化 → 空', () => {
    expect(detectCrossRepoTriggers(['README.md', 'src/util.ts'])).toEqual([]);
  });
});

describe('evaluateCrossRepoAccess', () => {
  it('同 tenant + enabled → 允许(只读)', () => {
    const a = evaluateCrossRepoAccess({ relationship: REL, sameTenant: true, explicitlyShared: false });
    expect(a.allowed).toBe(true);
    expect(a.readOnly).toBe(true);
  });
  it('非同 tenant 且无共享 → 拒绝', () => {
    const a = evaluateCrossRepoAccess({ relationship: REL, sameTenant: false, explicitlyShared: false });
    expect(a.allowed).toBe(false);
    expect(a.reasons.join()).toContain('无明确共享');
  });
  it('明确共享可跨 tenant;关系未启用则拒绝', () => {
    expect(evaluateCrossRepoAccess({ relationship: REL, sameTenant: false, explicitlyShared: true }).allowed).toBe(true);
    expect(evaluateCrossRepoAccess({ relationship: { ...REL, enabled: false }, sameTenant: true, explicitlyShared: false }).allowed).toBe(false);
  });
});

describe('attributeCrossRepoFinding', () => {
  it('标来源/消费者,修复走独立 CR', () => {
    const attr = attributeCrossRepoFinding(REL);
    expect(attr).toMatchObject({ sourceRepositoryId: 'src', consumerRepositoryId: 'tgt', fixRequiresSeparateChangeRequest: true });
  });
});

describe('discovery(0037 自动申请连线)', () => {
  it('parseManifest:package.json name/deps(devDependencies 不算)', () => {
    const m = parseManifest('package.json', JSON.stringify({ name: '@acme/core', dependencies: { lodash: '^4' }, peerDependencies: { react: '*' }, devDependencies: { vitest: '^3' } }));
    expect(m.provides).toEqual([{ ecosystem: 'npm', name: '@acme/core' }]);
    expect(m.depends.map((d) => d.name).sort()).toEqual(['lodash', 'react']);
  });
  it('parseManifest:go.mod module/require(单行 + 块)', () => {
    const m = parseManifest('go.mod', 'module github.com/acme/core\n\nrequire github.com/pkg/errors v0.9.1\n\nrequire (\n\tgolang.org/x/sync v0.7.0\n\tgithub.com/acme/lib v1.2.3 // indirect\n)\n');
    expect(m.provides[0]!.name).toBe('github.com/acme/core');
    expect(m.depends.map((d) => d.name).sort()).toEqual(['github.com/acme/lib', 'github.com/pkg/errors', 'golang.org/x/sync']);
  });
  it('parseManifest:Cargo.toml 与 pyproject.toml(pypi 名称 PEP 503 规范化)', () => {
    const cargo = parseManifest('Cargo.toml', '[package]\nname = "acme-core"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1", features = ["full"] }\n\n[dev-dependencies]\ninsta = "1"\n');
    expect(cargo.provides[0]!.name).toBe('acme-core');
    expect(cargo.depends.map((d) => d.name).sort()).toEqual(['serde', 'tokio']);
    const py = parseManifest('pyproject.toml', '[project]\nname = "Acme_Core"\ndependencies = [\n  "requests>=2",\n  "Pydantic_Settings[dotenv]==2.1",\n]\n');
    expect(py.provides[0]!.name).toBe('acme-core');
    expect(py.depends.map((d) => d.name).sort()).toEqual(['pydantic-settings', 'requests']);
  });
  it('parseManifest:坏文件/未知文件返回空(宽松)', () => {
    expect(parseManifest('package.json', '{not json')).toEqual({ provides: [], depends: [] });
    expect(parseManifest('README.md', 'anything')).toEqual({ provides: [], depends: [] });
  });
  it('matchRelationships:命中提议 library-dependent;自依赖排除;跨生态不误配;同对多包合并', () => {
    const proposals = matchRelationships([
      { repositoryId: 'A', role: 'provides', ecosystem: 'npm', name: 'foo' },
      { repositoryId: 'A', role: 'provides', ecosystem: 'npm', name: 'foo-utils' },
      { repositoryId: 'A', role: 'depends', ecosystem: 'npm', name: 'foo' }, // self-dependency
      { repositoryId: 'B', role: 'depends', ecosystem: 'npm', name: 'foo' },
      { repositoryId: 'B', role: 'depends', ecosystem: 'npm', name: 'foo-utils' },
      { repositoryId: 'C', role: 'depends', ecosystem: 'pypi', name: 'foo' }, // other ecosystem
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ sourceRepositoryId: 'A', targetRepositoryId: 'B', kind: 'library-dependent' });
    expect(proposals[0]!.rationale).toContain('npm:foo');
    expect(proposals[0]!.rationale).toContain('npm:foo-utils');
  });
});
