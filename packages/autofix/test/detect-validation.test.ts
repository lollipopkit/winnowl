import { describe, expect, it } from 'vitest';
import { detectValidationCommands } from '../src/index.js';

function reader(files: Record<string, string>): (path: string) => Promise<string | null> {
  return async (path) => files[path] ?? null;
}

describe('detectValidationCommands', () => {
  it('Node + pnpm-lock:install(frozen)→ lint/build/test,用 pnpm', async () => {
    const cmds = await detectValidationCommands(
      reader({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint', build: 'tsc', test: 'vitest', format: 'prettier -w' } }), 'pnpm-lock.yaml': '' }),
    );
    expect(cmds.map((c) => c.argv)).toEqual([
      ['pnpm', 'install', '--frozen-lockfile'],
      ['pnpm', 'run', 'lint'],
      ['pnpm', 'run', 'build'],
      ['pnpm', 'run', 'test'],
    ]);
    expect(cmds.map((c) => c.purpose)).toEqual(['bootstrap', 'lint', 'build', 'test']);
    // Formatters modify files, so they are not part of validation.
    expect(cmds.some((c) => c.argv.includes('format'))).toBe(false);
  });

  it('Node 无 lockfile → npm install;仅存在的 script 才生成', async () => {
    const cmds = await detectValidationCommands(reader({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) }));
    expect(cmds.map((c) => c.argv)).toEqual([
      ['npm', 'install'],
      ['npm', 'run', 'test'],
    ]);
  });

  it('Node + package-lock.json → npm ci', async () => {
    const cmds = await detectValidationCommands(reader({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'package-lock.json': '{}' }));
    expect(cmds[0]!.argv).toEqual(['npm', 'ci']);
  });

  it('yarn.lock → yarn install(frozen)', async () => {
    const cmds = await detectValidationCommands(reader({ 'package.json': JSON.stringify({ scripts: { build: 'x' } }), 'yarn.lock': '' }));
    expect(cmds[0]!.argv).toEqual(['yarn', 'install', '--frozen-lockfile']);
    expect(cmds[1]!.argv).toEqual(['yarn', 'run', 'build']);
  });

  it('Go module → mod download → vet/build/test', async () => {
    const cmds = await detectValidationCommands(reader({ 'go.mod': 'module x' }));
    expect(cmds.map((c) => c.argv)).toEqual([
      ['go', 'mod', 'download'],
      ['go', 'vet', './...'],
      ['go', 'build', './...'],
      ['go', 'test', './...'],
    ]);
  });

  it('Rust → cargo fetch/build/test', async () => {
    const cmds = await detectValidationCommands(reader({ 'Cargo.toml': '[package]' }));
    expect(cmds.map((c) => c.argv)).toEqual([['cargo', 'fetch'], ['cargo', 'build'], ['cargo', 'test']]);
  });

  it('Flutter(pubspec 含 flutter:)→ flutter pub get/analyze/test', async () => {
    const cmds = await detectValidationCommands(reader({ 'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n' }));
    expect(cmds.map((c) => c.argv)).toEqual([
      ['flutter', 'pub', 'get'],
      ['flutter', 'analyze'],
      ['flutter', 'test'],
    ]);
  });

  it('纯 Dart(pubspec 无 flutter)→ dart pub get/analyze/test', async () => {
    const cmds = await detectValidationCommands(reader({ 'pubspec.yaml': 'name: pkg\nenvironment:\n  sdk: ">=3.0.0"\n' }));
    expect(cmds.map((c) => c.argv[0])).toEqual(['dart', 'dart', 'dart']);
    expect(cmds[0]!.argv).toEqual(['dart', 'pub', 'get']);
  });

  it('Python pyproject(无 requirements)→ pip install -e . → pytest', async () => {
    const cmds = await detectValidationCommands(reader({ 'pyproject.toml': '[tool.pytest]' }));
    expect(cmds.map((c) => c.argv)).toEqual([
      ['pip', 'install', '-e', '.'],
      ['python', '-m', 'pytest', '-q'],
    ]);
  });

  it('Python + requirements.txt → pip install -r → pytest', async () => {
    const cmds = await detectValidationCommands(reader({ 'requirements.txt': 'flask==2.0' }));
    expect(cmds[0]!.argv).toEqual(['pip', 'install', '-r', 'requirements.txt']);
  });

  it('install 命令 purpose=bootstrap(出网,长 timeout)', async () => {
    const cmds = await detectValidationCommands(reader({ 'go.mod': 'module x' }));
    expect(cmds[0]!.purpose).toBe('bootstrap');
    expect(cmds[0]!.timeoutMs).toBeGreaterThanOrEqual(600_000);
  });

  it('未识别清单 → 空(不臆造命令)', async () => {
    expect(await detectValidationCommands(reader({ 'README.md': '# x' }))).toEqual([]);
  });

  it('package.json 非法 JSON → 无 scripts,但仍装依赖(install 保留)', async () => {
    const cmds = await detectValidationCommands(reader({ 'package.json': '{ not json' }));
    expect(cmds.map((c) => c.argv)).toEqual([['npm', 'install']]);
  });

  it('leaves out flutter test when the project has no test directory (only when it can tell)', async () => {
    const files: Record<string, string> = { 'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n' };
    const read = async (p: string) => files[p] ?? null;
    const argv = (cmds: { argv: string[] }[]) => cmds.map((c) => c.argv.join(' '));
    expect(argv(await detectValidationCommands(read, async () => false))).toEqual(['flutter pub get', 'flutter analyze']);
    expect(argv(await detectValidationCommands(read, async () => true))).toContain('flutter test');
    expect(argv(await detectValidationCommands(read))).toContain('flutter test');
  });
});

