import { describe, expect, it } from 'vitest';
import { resolveValidationCommands } from '../src/index.js';

function reader(files: Record<string, string>): (path: string) => Promise<string | null> {
  return async (path) => files[path] ?? null;
}

const nodeRepo = reader({
  'package.json': JSON.stringify({ scripts: { lint: 'eslint', build: 'tsc', test: 'vitest' } }),
  'pnpm-lock.yaml': '',
});

describe('resolveValidationCommands(§37 tools 接线)', () => {
  it('无 tools 配置 → 等同纯自动探测', async () => {
    const cmds = await resolveValidationCommands(nodeRepo);
    expect(cmds.map((c) => c.argv)).toEqual([
      ['pnpm', 'install', '--frozen-lockfile'],
      ['pnpm', 'run', 'lint'],
      ['pnpm', 'run', 'build'],
      ['pnpm', 'run', 'test'],
    ]);
  });

  it('显式 commands 覆盖同阶段自动探测,其余阶段仍自动', async () => {
    const cmds = await resolveValidationCommands(nodeRepo, {
      auto_detect: true,
      commands: { setup: [], build: [], lint: [], test: ['pnpm -r test -- --coverage'] },
    });
    // Explicit test command replaces detection; setup/lint/build stay detected.
    expect(cmds.map((c) => c.argv)).toEqual([
      ['pnpm', 'install', '--frozen-lockfile'],
      ['pnpm', 'run', 'lint'],
      ['pnpm', 'run', 'build'],
      ['sh', '-lc', 'pnpm -r test -- --coverage'],
    ]);
    expect(cmds.at(-1)?.purpose).toBe('test');
  });

  it('auto_detect=false → 只跑显式命令(阶段顺序 setup→lint→build→test)', async () => {
    const cmds = await resolveValidationCommands(nodeRepo, {
      auto_detect: false,
      commands: { test: ['make test'], setup: ['make deps'] },
    });
    expect(cmds.map((c) => c.argv)).toEqual([
      ['sh', '-lc', 'make deps'],
      ['sh', '-lc', 'make test'],
    ]);
    expect(cmds.map((c) => c.purpose)).toEqual(['bootstrap', 'test']);
  });

  it('auto_detect=false 且无显式命令 → 空(调用方据此 not-run,不建沙盒)', async () => {
    expect(await resolveValidationCommands(nodeRepo, { auto_detect: false })).toEqual([]);
  });

  it('disabled 剔除阶段;enabled 非空为白名单;disabled 优先', async () => {
    const noTest = await resolveValidationCommands(nodeRepo, { disabled: ['test', 'build'] });
    expect(noTest.map((c) => c.purpose)).toEqual(['bootstrap', 'lint']);

    const onlySetupTest = await resolveValidationCommands(nodeRepo, { enabled: ['setup', 'test'] });
    expect(onlySetupTest.map((c) => c.purpose)).toEqual(['bootstrap', 'test']);

    const conflict = await resolveValidationCommands(nodeRepo, { enabled: ['setup', 'test'], disabled: ['test'] });
    expect(conflict.map((c) => c.purpose)).toEqual(['bootstrap']);
  });

  it('空白命令串被忽略(不产生空 sh -lc)', async () => {
    const cmds = await resolveValidationCommands(reader({}), { commands: { test: ['   ', 'pytest'] } });
    expect(cmds.map((c) => c.argv)).toEqual([['sh', '-lc', 'pytest']]);
  });
});
