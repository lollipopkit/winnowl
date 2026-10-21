import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPlatformSkills, loadPromptBundle, loadPromptBundles, parseSkill, promptBundleDigest, SKILL_MAX_CHARS, SKILL_NAME } from '../src/index.js';

describe('prompt bundles', () => {
  it('加载单个角色 bundle 并计算 digest', async () => {
    const b = await loadPromptBundle('mapper');
    expect(b.role).toBe('mapper');
    expect(b.system.length).toBeGreaterThan(0);
    expect(b.task.length).toBeGreaterThan(0);
    expect(b.version).toBe(5);
    expect(b.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('多角色 bundle + 组合 digest 确定性', async () => {
    const bundles = await loadPromptBundles(['mapper', 'reviewer', 'synthesizer']);
    const list = Object.values(bundles);
    expect(list).toHaveLength(3);
    const d1 = promptBundleDigest(list);
    const d2 = promptBundleDigest([...list].reverse());
    expect(d1).toBe(d2); // order-independent
  });
});

// The finalization tool named in each prompt must be the one actually registered in code.
describe('prompt 点名的工具与代码注册一致', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'test') return [];
      const p = join(dir, e.name);
      return e.isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
    });
  const registered = new Set(
    [...sourceFiles(join(root, 'packages')), ...sourceFiles(join(root, 'apps'))].flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]!),
    ),
  );

  it('每个 prompt 里的 `submit_*` / `complete_*` / `confirm_*` 都有注册', () => {
    const dir = join(root, 'prompts');
    const named = readdirSync(dir).flatMap((role) =>
      ['system.md', 'task.md'].flatMap((file) => {
        const p = join(dir, role, file);
        return existsSync(p)
          ? [...readFileSync(p, 'utf8').matchAll(/`((?:submit|complete|confirm)_[a-z_]+)`/g)].map((m) => `${role}: ${m[1]}`)
          : [];
      }),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !registered.has(n.split(': ')[1]!))).toEqual([]);
  });
});

describe('检查清单(skill)', () => {
  it('平台清单都能解析:名字合法、有描述与正文、按名字排序', async () => {
    const skills = await loadPlatformSkills();
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(s.name).toMatch(SKILL_NAME);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
      expect(s.source).toBe('platform');
    }
    expect(skills.map((s) => s.name)).toEqual([...skills.map((s) => s.name)].sort());
  });

  it('parseSkill:名字不合法丢弃;正文截断到上限', () => {
    expect(parseSkill('---\nname: ../evil\n---\nbody', 'x', 'repository')).toBeNull();
    expect(parseSkill('---\nname: ok\n---\n', 'x', 'repository')).toBeNull(); // empty body
    const long = parseSkill(`---\nname: big\n---\n${'a'.repeat(SKILL_MAX_CHARS + 50)}`, 'x', 'repository')!;
    expect(long.body).toHaveLength(SKILL_MAX_CHARS);
    expect(parseSkill('no front matter', 'plain-file', 'repository')).toMatchObject({ name: 'plain-file', body: 'no front matter' });
  });
});
