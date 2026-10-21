import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addWorktree,
  changedFilesBetween,
  diffFromMergeBase,
  diffRange,
  mergeBase,
  readFileAtRevision,
  removeWorktree,
  revParse,
  runGit,
} from '../src/index.js';

describe('git-repository', () => {
  let dir: string;
  let baseSha: string;
  let headSha: string;
  const cleanups: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvb-git-'));
    cleanups.push(dir);
    await runGit(dir, ['init', '-q']);
    const commit = (msg: string) => runGit(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg]);

    await writeFile(join(dir, 'a.ts'), 'line1\nline2\nline3\n');
    await runGit(dir, ['add', '.']);
    await commit('base');
    baseSha = await revParse(dir, 'HEAD');

    await writeFile(join(dir, 'a.ts'), 'line1\nline2-changed\nline3\n');
    await writeFile(join(dir, 'b.ts'), 'new file\n');
    await runGit(dir, ['add', '.']);
    await commit('head');
    headSha = await revParse(dir, 'HEAD');
  });

  afterAll(async () => {
    for (const d of cleanups) await rm(d, { recursive: true, force: true });
  });

  it('merge-base', async () => {
    expect(await mergeBase(dir, baseSha, headSha)).toBe(baseSha);
  });

  it('diffRange:修改 + 新增文件', async () => {
    const d = await diffRange(dir, baseSha, headSha);
    const paths = d.files.map((f) => f.newPath).sort();
    expect(paths).toEqual(['a.ts', 'b.ts']);
    const a = d.files.find((f) => f.newPath === 'a.ts')!;
    expect(a.status).toBe('modified');
    expect(a.language).toBe('typescript');
    const b = d.files.find((f) => f.newPath === 'b.ts')!;
    expect(b.status).toBe('added');
  });

  it('diffFromMergeBase', async () => {
    const { mergeBaseSha, diff } = await diffFromMergeBase(dir, baseSha, headSha);
    expect(mergeBaseSha).toBe(baseSha);
    expect(diff.stats.filesChanged).toBe(2);
  });

  it('readFileAtRevision', async () => {
    expect(await readFileAtRevision(dir, headSha, 'b.ts')).toBe('new file\n');
    expect(await readFileAtRevision(dir, baseSha, 'b.ts')).toBeNull();
  });

  // A rename must count both paths as changed.
  it('changedFilesBetween 带上重命名的两端', async () => {
    const before = await revParse(dir, 'HEAD');
    await runGit(dir, ['mv', 'b.ts', 'c.ts']);
    await runGit(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'rename b→c']);
    const after = await revParse(dir, 'HEAD');

    const changed = await changedFilesBetween(dir, before, after);
    expect(changed).not.toBeNull();
    expect([...(changed ?? [])].sort()).toEqual(['b.ts', 'c.ts']);
  });

  it('addWorktree 快照', async () => {
    const wt = join(await mkdtemp(join(tmpdir(), 'rvb-wt-')), 'snap');
    await addWorktree(dir, wt, headSha);
    expect(existsSync(join(wt, 'b.ts'))).toBe(true);
    await removeWorktree(dir, wt);
  });
});
