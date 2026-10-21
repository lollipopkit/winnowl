import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkoutSubmodules, gitlinksAt, runGit, submoduleChanges, submoduleFetchUrl } from '../src/index.js';

const REPO = 'https://github.com/acme/app.git';

describe('submoduleFetchUrl: .gitmodules is untrusted input', () => {
  it.each([
    ['https://github.com/acme/lib', 'https://github.com/acme/lib'],
    ['https://GitHub.com/other/lib.git', 'https://github.com/other/lib.git'],
    ['../lib.git', 'https://github.com/acme/lib.git'],
    ['./sub', 'https://github.com/acme/app.git/sub'],
  ])('allows %s', (raw, want) => {
    expect(submoduleFetchUrl(raw, REPO)).toBe(want);
  });

  it.each([
    'git@github.com:acme/lib.git', // ssh
    'ssh://git@github.com/acme/lib',
    'http://github.com/acme/lib', // plain http
    'https://gitlab.com/acme/lib', // another host
    'https://100.64.0.1:8080/v1', // a private address
    'https://github.com:8443/acme/lib', // another port
    'https://user:token@github.com/acme/lib', // credentials
    'https://github.com/acme/lib?x=1',
    'file:///etc',
    'ext::sh -c id',
    '/abs/path',
  ])('refuses %s', (raw) => {
    expect(submoduleFetchUrl(raw, REPO)).toBeNull();
  });

  it('refuses everything when the repository itself is not https (local clones in tests)', () => {
    expect(submoduleFetchUrl('https://github.com/acme/lib', '/tmp/repo')).toBeNull();
  });
});

describe('checkoutSubmodules', () => {
  let dir: string;
  let worktree: string;
  const git = (...args: string[]) => runGit(worktree, args);
  const sha = 'a'.repeat(40);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvb-sub-'));
    worktree = join(dir, 'wt');
    await mkdir(worktree);
    await git('init', '-q', '-b', 'main');
    await writeFile(join(worktree, 'README'), 'x\n');
    await writeFile(
      join(worktree, '.gitmodules'),
      [
        '[submodule "ssh"]', '\tpath = libs/ssh', '\turl = git@github.com:acme/ssh.git',
        '[submodule "foreign"]', '\tpath = libs/foreign', '\turl = https://evil.example/x.git',
        '[submodule "local"]', '\tpath = libs/local', '\turl = file:///etc',
        '[include]', '\tpath = /etc/gitconfig',
      ].join('\n') + '\n',
    );
    // Gitlinks without fetching anything: index entries of mode 160000.
    for (const p of ['libs/ssh', 'libs/foreign', 'libs/local', 'libs/unlisted']) {
      await git('update-index', '--add', '--cacheinfo', `160000,${sha},${p}`);
    }
    await git('add', 'README', '.gitmodules');
    await git('-c', 'user.email=t@t.co', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    for (const p of ['libs/ssh', 'libs/foreign', 'libs/local', 'libs/unlisted']) await mkdir(join(worktree, p), { recursive: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips every submodule it may not fetch, without touching the network, and says why', async () => {
    const out = await checkoutSubmodules(worktree, REPO);
    expect(out).toEqual([
      { path: 'libs/foreign', sha, status: 'skipped', reason: 'URL is not https on the repository host' },
      { path: 'libs/local', sha, status: 'skipped', reason: 'URL is not https on the repository host' },
      { path: 'libs/ssh', sha, status: 'skipped', reason: 'URL is not https on the repository host' },
      { path: 'libs/unlisted', sha, status: 'skipped', reason: 'not listed in .gitmodules' },
    ]);
    for (const p of ['libs/ssh', 'libs/foreign']) expect(await readdir(join(worktree, p))).toEqual([]);
  });

  it('caps the count', async () => {
    const out = await checkoutSubmodules(worktree, REPO, { max: 1 });
    expect(out.filter((s) => s.reason === 'more than 1 submodules')).toHaveLength(3);
  });

  it('never checks out through a symlinked directory', async () => {
    const outside = join(dir, 'outside');
    await mkdir(outside);
    await writeFile(join(worktree, '.gitmodules'), '[submodule "s"]\n\tpath = libs/ssh\n\turl = https://github.com/acme/s.git\n');
    await rm(join(worktree, 'libs/ssh'), { recursive: true });
    await symlink(outside, join(worktree, 'libs/ssh'));
    const out = await checkoutSubmodules(worktree, REPO);
    expect(out.find((s) => s.path === 'libs/ssh')).toMatchObject({
      status: 'skipped',
      reason: 'path is not an empty directory inside the worktree',
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it('a tree without gitlinks has nothing to do', async () => {
    const plain = join(dir, 'plain');
    await mkdir(plain);
    await runGit(plain, ['init', '-q']);
    await writeFile(join(plain, 'a'), 'a');
    await runGit(plain, ['add', 'a']);
    await runGit(plain, ['-c', 'user.email=t@t.co', '-c', 'user.name=t', 'commit', '-q', '-m', 'a']);
    expect(await checkoutSubmodules(plain, REPO)).toEqual([]);
  });
});

describe('submoduleChanges / gitlinksAt', () => {
  let dir: string;
  const git = (...args: string[]) => runGit(dir, args);
  const commit = async (m: string): Promise<string> => {
    await git('add', '-A');
    await git('-c', 'user.email=t@t.co', '-c', 'user.name=t', 'commit', '-q', '-m', m);
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvb-subdiff-'));
    await git('init', '-q', '-b', 'main');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists the files that differ between two pins, renames under their new path, capped', async () => {
    await mkdir(join(dir, 'lib'));
    await writeFile(join(dir, 'lib/a.dart'), 'a\n');
    await writeFile(join(dir, 'lib/old_name.dart'), 'same content for rename detection\n'.repeat(5));
    await writeFile(join(dir, 'gone.txt'), 'x\n');
    const from = await commit('from');
    await writeFile(join(dir, 'lib/a.dart'), 'b\n');
    await git('mv', 'lib/old_name.dart', 'lib/new_name.dart');
    await rm(join(dir, 'gone.txt'));
    await writeFile(join(dir, 'added.txt'), 'y\n');
    const to = await commit('to');

    expect(await submoduleChanges(dir, from, to)).toEqual({
      files: [
        { status: 'A', path: 'added.txt' },
        { status: 'D', path: 'gone.txt' },
        { status: 'M', path: 'lib/a.dart' },
        { status: 'R', path: 'lib/new_name.dart' },
      ],
      total: 4,
    });
    expect((await submoduleChanges(dir, from, to, 2))?.files).toHaveLength(2);
    expect((await submoduleChanges(dir, from, to, 2))?.total).toBe(4);
    expect(await submoduleChanges(dir, 'c'.repeat(40), to)).toBeNull();
  });

  it('reads the gitlinks of any commit', async () => {
    const pin = 'd'.repeat(40);
    await git('update-index', '--add', '--cacheinfo', `160000,${pin},vendor/lib`);
    await git('-c', 'user.email=t@t.co', '-c', 'user.name=t', 'commit', '-q', '-m', 'link');
    expect(await gitlinksAt(dir, 'HEAD')).toEqual(new Map([['vendor/lib', pin]]));
    expect(await gitlinksAt(dir, 'HEAD~1')).toEqual(new Map());
  });
});
