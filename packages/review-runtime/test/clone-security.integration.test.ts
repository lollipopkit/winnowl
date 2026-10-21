import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authedCloneUrl, cloneRepository, cloneUrlWithoutCredentials } from '../src/workspace.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('cloneRepository 安全(§sandbox)', () => {
  let root: string;
  let source: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'clone-sec-'));
    source = join(root, 'source');
    await mkdir(source);
    git(source, 'init', '-q');
    git(source, 'config', 'user.email', 't@t');
    git(source, 'config', 'user.name', 't');
    // Malicious .gitmodules with an ext:: url (committed as text only).
    await writeFile(
      join(source, '.gitmodules'),
      `[submodule "evil"]\n\tpath = evil\n\turl = ext::sh -c "touch ${join(root, 'PWNED')}"\n`,
    );
    await writeFile(join(source, 'README.md'), '# victim\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-qm', 'init');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('clone 不取 submodule,且持久化拒 ext::/file:: 协议', async () => {
    const target = join(root, 'clone');
    await cloneRepository(source, target);
    expect(git(target, 'config', '--get', 'protocol.ext.allow').trim()).toBe('never');
    expect(git(target, 'config', '--get', 'protocol.file.allow').trim()).toBe('never');
    expect(existsSync(join(target, 'evil'))).toBe(false);
  });

  it('ext:: 命令注入被配置拒绝(等价恶意 submodule fetch,命令不执行)', async () => {
    const target = join(root, 'clone2');
    await cloneRepository(source, target);
    // Same vector as a submodule fetch: git must refuse ext::.
    let failed = false;
    try {
      execFileSync('git', ['ls-remote', `ext::sh -c "touch ${join(root, 'PWNED')}"`], {
        cwd: target,
        stdio: 'pipe',
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
  });

  it('removes credentials before persisting an authenticated clone remote', () => {
    const cloneUrl = authedCloneUrl('https://github.example/acme/repo.git', 'installation-token');
    expect(cloneUrlWithoutCredentials(cloneUrl)).toBe('https://github.example/acme/repo.git');
  });

  it('removes a partial clone target when clone setup fails', async () => {
    const target = join(root, 'failed-clone');
    await expect(cloneRepository(join(root, 'missing-source'), target)).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });
});
