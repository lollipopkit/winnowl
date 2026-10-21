import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  applyPatchToTree,
  collectTreeChanges,
  deliverStackedChangeRequest,
  safeTreePath,
  type RunGit,
  fuzzyReplaceBlock,
  parseStructuredPatch,
  sanitizePatch,
  stripWorkflowChanges,
} from '../src/index.js';

describe('fuzzyReplaceBlock — apply_patch 上下文空白偏差兜底(§28.1)', () => {
  it('缩进不同也能定位并替换(逐行 trim)', () => {
    const content = 'function f() {\n      return a + b;\n}\n';
    // oldText is indented 2 spaces, the source 6: only the fuzzy match hits.
    const out = fuzzyReplaceBlock(content, '  return a + b;', '  return a * b;');
    expect(out).not.toBeNull();
    expect(out).toContain('return a * b;');
    expect(out).not.toContain('a + b');
  });

  it('完全找不到 → null', () => {
    expect(fuzzyReplaceBlock('const x = 1;\n', 'return nope;', 'return ok;')).toBeNull();
  });
});

describe('parseStructuredPatch — OpenAI apply_patch(V4A)', () => {
  it('解析 update 段并剔除 workflow 段', () => {
    const p = [
      '*** Begin Patch',
      '*** Update File: .github/workflows/ci.yml',
      '@@',
      '-a',
      '+b',
      '*** Update File: src/x.js',
      '@@',
      ' keep',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const { files, stripped } = parseStructuredPatch(p);
    expect(stripped).toContain('.github/workflows/ci.yml');
    expect(files.map((f) => f.path)).toEqual(['src/x.js']);
    expect(files[0]!.hunks[0]).toEqual({ oldText: 'keep\nold', newText: 'keep\nnew' });
  });
});

describe('sanitizePatch — LLM 输出规范化', () => {
  it('剥离 ```diff 围栏与前言,保留有效 diff', () => {
    const raw = 'Here is the fix:\n```diff\ndiff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n```\n';
    const out = sanitizePatch(raw);
    expect(out.startsWith('diff --git a/x.ts b/x.ts')).toBe(true);
    expect(out).not.toContain('```');
    expect(out).not.toContain('Here is the fix');
  });
});

describe('stripWorkflowChanges — 剔除 CI workflow 改动(App 无 workflows 权限)', () => {
  const wf = 'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-a\n+b\n';
  const src = 'diff --git a/src/main.js b/src/main.js\n--- a/src/main.js\n+++ b/src/main.js\n@@ -1 +1 @@\n-return a + b;\n+return a * b;\n';

  it('丢弃 .github/workflows/ 段,保留源码段', () => {
    const { patch, stripped } = stripWorkflowChanges(wf + src);
    expect(stripped).toEqual(['.github/workflows/ci.yml']);
    expect(patch).toContain('src/main.js');
    expect(patch).not.toContain('.github/workflows/');
  });

  it('全为 workflow 改动 → 过滤后为空', () => {
    const { patch, stripped } = stripWorkflowChanges(wf);
    expect(patch.trim()).toBe('');
    expect(stripped).toHaveLength(1);
  });
});

const exec = promisify(execFile);
const git: RunGit = async (dir, args) => exec('git', args, { cwd: dir });

/** A worktree with one commit: what a workspace's head tree looks like when the patch arrives. */
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fix-tree-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.email=t@t.co', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  return dir;
}
const b64 = (s: string): string => Buffer.from(s).toString('base64');

describe('applyPatchToTree + collectTreeChanges(工作区里应用 patch,读出提交输入)', () => {
  it('V4A patch edits by context and adds files; the changes come back with mode and content', async () => {
    const dir = await repo({ 'src/math.js': 'export function mul(a, b) {\n  return a + b;\n}\n' });
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/math.js',
      '@@',
      ' export function mul(a, b) {',
      '-  return a + b;',
      '+  return a * b;',
      ' }',
      '*** Add File: src/new/util.js',
      '+export const one = 1;',
      '*** End Patch',
    ].join('\n');
    await applyPatchToTree(dir, patch, git);
    expect(await readFile(join(dir, 'src', 'math.js'), 'utf8')).toContain('return a * b;');
    expect(await collectTreeChanges(dir, git)).toEqual([
      { path: 'src/math.js', mode: '100644', contentBase64: b64('export function mul(a, b) {\n  return a * b;\n}\n') },
      { path: 'src/new/util.js', mode: '100644', contentBase64: b64('export const one = 1;\n') },
    ]);
  });

  it('a unified diff whose line numbers are off still applies (--3way / --recount); deletions are reported', async () => {
    const dir = await repo({ 'a.txt': 'one\ntwo\nthree\n', 'gone.txt': 'x\n' });
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -5,3 +5,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
    ].join('\n');
    await applyPatchToTree(dir, patch, git);
    expect(await collectTreeChanges(dir, git)).toEqual([
      { path: 'a.txt', mode: '100644', contentBase64: b64('one\nTWO\nthree\n') },
      { path: 'gone.txt', deleted: true },
    ]);
  });

  it('workflow files never make it into the commit', async () => {
    const dir = await repo({ '.github/workflows/ci.yml': 'on: push\n', 'src/x.js': 'a\n' });
    // No `diff --git` header: stripWorkflowChanges cannot see it, collectTreeChanges drops it.
    const patch = ['--- a/.github/workflows/ci.yml', '+++ b/.github/workflows/ci.yml', '@@ -1 +1 @@', '-on: push', '+on: pull_request', ''].join('\n');
    await applyPatchToTree(dir, patch, git);
    expect(await collectTreeChanges(dir, git)).toEqual([]);
  });

  it('refuses V4A paths that leave the tree (the model writes them; PR content can steer the model)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'fix-outside-'));
    const dir = await repo({ 'a.txt': 'a\n' });
    await symlink(outside, join(dir, 'link'));
    const add = (path: string) => ['*** Begin Patch', `*** Add File: ${path}`, '+pwned', '*** End Patch'].join('\n');
    await expect(applyPatchToTree(dir, add('../escape.txt'), git)).rejects.toThrow(/escapes the tree/);
    await expect(applyPatchToTree(dir, add('/etc/escape.txt'), git)).rejects.toThrow(/escapes the tree/);
    await expect(applyPatchToTree(dir, add('.git/hooks/post-checkout'), git)).rejects.toThrow(/inside \.git/);
    await expect(applyPatchToTree(dir, add('link/escape.txt'), git)).rejects.toThrow(/via a symlink/);
    await expect(safeTreePath(dir, 'src/ok.txt')).resolves.toContain('src');
  });
});

describe('deliverStackedChangeRequest', () => {
  const changes = [{ path: 'x', mode: '100644' as const, contentBase64: b64('b\n') }];

  it('commits the changes on base to the bot branch, then opens the CR from it', async () => {
    const commits: unknown[] = [];
    const opened: { sourceBranch: string; targetBranch: string; body: string }[] = [];
    const result = await deliverStackedChangeRequest(
      {
        commitChanges: async (input) => {
          commits.push(input);
          return 'bot-head-sha';
        },
        openChangeRequest: async (input) => {
          opened.push({ sourceBranch: input.sourceBranch, targetBranch: input.targetBranch, body: input.body });
          return { number: 99, url: 'https://x/pull/99' };
        },
      },
      {
        changes,
        branch: 'winnowl/42/act-1',
        baseSha: 'head-sha',
        targetBranch: 'feature/x',
        title: 'reviewbot: fix',
        body: 'stacked',
        validationNote: 'validated',
        botIdentity: { name: 'reviewbot', email: 'bot@rb' },
      },
    );
    expect(commits).toEqual([
      { baseSha: 'head-sha', branch: 'winnowl/42/act-1', message: 'reviewbot: fix', author: { name: 'reviewbot', email: 'bot@rb' }, changes },
    ]);
    expect(opened).toEqual([{ sourceBranch: 'winnowl/42/act-1', targetBranch: 'feature/x', body: 'stacked\n\nvalidated' }]);
    expect(result).toEqual({ branch: 'winnowl/42/act-1', headSha: 'bot-head-sha', changeRequest: { number: 99, url: 'https://x/pull/99' } });
  });

  it('never writes outside the bot namespace, and refuses an empty change', async () => {
    const deps = { commitChanges: async () => 's', openChangeRequest: async () => ({ number: 1 }) };
    const input = { changes, baseSha: 's', targetBranch: 'main', title: 't', body: 'b' };
    await expect(deliverStackedChangeRequest(deps, { ...input, branch: 'feature/x' })).rejects.toThrow(/not a bot branch/);
    await expect(deliverStackedChangeRequest(deps, { ...input, branch: 'winnowl/1/a', changes: [] })).rejects.toThrow(/没有可提交的改动/);
  });

  it('checks execution ownership immediately before the commit and the CR creation', async () => {
    const events: string[] = [];
    await deliverStackedChangeRequest(
      {
        commitChanges: async () => {
          events.push('commit');
          return 's';
        },
        assertLease: async () => void events.push('lease'),
        openChangeRequest: async () => {
          events.push('create');
          return { number: 1 };
        },
      },
      { changes, branch: 'winnowl/1/a', baseSha: 's', targetBranch: 'main', title: 't', body: 'b' },
    );
    expect(events).toEqual(['lease', 'commit', 'lease', 'create']);
  });
});
