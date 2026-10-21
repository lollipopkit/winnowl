import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcessFromStream, tarDirectory } from '../src/index.js';

describe('tarDirectory', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvb-tar-'));
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.ts'), 'a');
    await writeFile(join(dir, '-rf'), 'not an option');
    await writeFile(join(dir, '.gitmodules'), '');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('archives the entries but not the directory itself (extracting must not touch the destination)', async () => {
    const tar = tarDirectory(dir);
    const listed = await runProcessFromStream('tar', ['-tf', '-'], tar.stream, { timeoutMs: 10_000, maxOutputBytes: 100_000 });
    await tar.done;
    const names = listed.stdout.split('\n').filter(Boolean).map((n) => n.replace(/\/$/, '')).sort();
    expect(names).toEqual(['./-rf', './.gitmodules', './src', './src/a.ts']);
  });

  it('keeps the archive for a reader that starts late (tar of a small tree has exited by then)', async () => {
    const tar = tarDirectory(dir);
    await tar.done;
    await new Promise((r) => setTimeout(r, 200));
    const listed = await runProcessFromStream('tar', ['-tf', '-'], tar.stream, { timeoutMs: 10_000, maxOutputBytes: 100_000 });
    expect(listed.stdout).toContain('./src/a.ts');
  });
});
