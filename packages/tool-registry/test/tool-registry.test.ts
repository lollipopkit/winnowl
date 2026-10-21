import { describe, expect, it } from 'vitest';
import {
  detectProject,
  differential,
  newDiagnostics,
  type NormalizedDiagnostic,
  type ReadFile,
} from '../src/index.js';

function fileMap(files: Record<string, string>): ReadFile {
  return async (path) => files[path] ?? null;
}

describe('detectProject', () => {
  it('Node/TypeScript:从 package.json scripts 发现命令', async () => {
    const ctx = await detectProject(
      fileMap({
        'package.json': JSON.stringify({
          scripts: { build: 'tsc', lint: 'eslint .', test: 'vitest' },
          devDependencies: { typescript: '^5' },
        }),
      }),
    );
    expect(ctx.languages).toContain('typescript');
    expect(ctx.commands.lint).toEqual(['npm', 'run', 'lint']);
    expect(ctx.commands.test).toEqual(['npm', 'run', 'test']);
  });

  it('Go:go.mod → go 命令', async () => {
    const ctx = await detectProject(fileMap({ 'go.mod': 'module x\n' }));
    expect(ctx.languages).toContain('go');
    expect(ctx.commands.test).toEqual(['go', 'test', './...']);
  });

  it('未知语言仍返回(命令留空,Coverage 说明缺失)', async () => {
    const ctx = await detectProject(fileMap({ 'main.zig': 'x' }));
    expect(ctx.languages).toEqual([]);
    expect(ctx.commands.build).toEqual([]);
  });
});

describe('base/head differential', () => {
  const base: NormalizedDiagnostic[] = [
    { toolId: 'eslint', ruleId: 'no-unused', severity: 'warning', message: 'x unused', path: 'a.ts', line: 3 },
    { toolId: 'tsc', ruleId: 'TS2322', severity: 'error', message: 'type error', path: 'b.ts', line: 10 },
  ];
  const head: NormalizedDiagnostic[] = [
    // persisted: same rule, file and line
    { toolId: 'eslint', ruleId: 'no-unused', severity: 'warning', message: 'x unused', path: 'a.ts', line: 3 },
    // moved: same rule and file, different line
    { toolId: 'tsc', ruleId: 'TS2322', severity: 'error', message: 'type error', path: 'b.ts', line: 14 },
    { toolId: 'tsc', ruleId: 'TS2531', severity: 'error', message: 'possibly null', path: 'c.ts', line: 5 },
  ];

  it('分类 new/persisted/moved 并识别 resolved', () => {
    const result = differential(base, head);
    const byMsg = Object.fromEntries(result.classified.map((c) => [c.message, c.diffClass]));
    expect(byMsg['x unused']).toBe('persisted');
    expect(byMsg['type error']).toBe('moved');
    expect(byMsg['possibly null']).toBe('new');
    expect(result.resolved).toHaveLength(0);
  });

  it('只有 new 默认进入 Candidate', () => {
    const result = differential(base, head);
    const fresh = newDiagnostics(result);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.message).toBe('possibly null');
  });

  it('base 有、head 无 → resolved', () => {
    const result = differential(base, []);
    expect(result.resolved).toHaveLength(2);
    expect(result.classified).toHaveLength(0);
  });
});
