import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listManifests } from '../src/workspace-executor.js';

describe('listManifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'rvb-manifests-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('收各层的依赖清单,跳过依赖 / 产物 / 隐藏目录与过深的层', async () => {
    const put = (rel: string, text = 'x') => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put('package.json');
    put('apps/mobile/pubspec.yaml', 'dependencies:\n  material_ui: ^1.5.0\n');
    put('services/api/requirements-dev.txt');
    put('node_modules/react/package.json');
    put('.dart_tool/package_config.json');
    put('build/pubspec.yaml');
    put('.github/pubspec.yaml');
    put('a/b/c/d/e/Cargo.toml'); // beyond max depth
    put('README.md');
    put('apps/mobile/pubspec.lock'); // lockfiles are collected too (versions only)
    put('node_modules/x/package-lock.json');
    const found = (await listManifests(root)).sort();
    expect(found).toEqual(['apps/mobile/pubspec.lock', 'apps/mobile/pubspec.yaml', 'package.json', 'services/api/requirements-dev.txt']);
  });
});
