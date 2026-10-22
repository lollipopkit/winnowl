import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revParse, runGit } from '@reviewbot/git-repository';
import {
  CodePlaneReader,
  codePlaneClient,
  localDispatch,
  openLocalWorkspace,
  WorkspaceHeadMissingError,
  type CodePlaneRequest,
} from '../src/index.js';

describe('code plane: workspace executor + control-side reader', () => {
  let repo: string;
  let root: string;
  let base: string;
  let head: string;
  let later: string;

  const git = (...args: string[]) => runGit(repo, args);
  const commit = async (message: string): Promise<string> => {
    await git('add', '-A', '-f');
    await git('-c', 'user.email=t@t.co', '-c', 'user.name=t', 'commit', '-m', message);
    return revParse(repo, 'HEAD');
  };
  const put = async (rel: string, text: string): Promise<void> => {
    await mkdir(join(repo, rel, '..'), { recursive: true });
    await writeFile(join(repo, rel), text);
  };

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'rvb-cp-repo-'));
    root = await mkdtemp(join(tmpdir(), 'rvb-cp-ws-'));
    await git('init', '-q', '-b', 'main');
    await put('app.py', 'def add(a, b):\n    return a + b\n');
    await put('.gitattributes', 'gen/** linguist-generated\n');
    await put('.winnowl/skills/sql.md', '---\nname: sql-safety\ndescription: SQL checks\n---\nCheck SQL injection.\n');
    await put('.winnowl.yaml', 'reviews:\n  profile: thorough\n');
    // A submodule pointer the change moves (a local clone never fetches it).
    await git('update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},libs/sub`);
    await mkdir(join(repo, 'libs/sub'), { recursive: true });
    base = await commit('base');
    await git('update-index', '--cacheinfo', `160000,${'b'.repeat(40)},libs/sub`);
    await put('app.py', 'def add(a, b):\n    return a - b\n');
    await put('gen/client.py', 'x = 1\n');
    await put('pubspec.yaml', 'dependencies:\n  http: ^1.0.0\n');
    // A PR must not change the instructions it is reviewed with: these stay at base.
    await put('.winnowl.yaml', 'reviews:\n  profile: chill\n');
    head = await commit('head');
    await put('app.py', 'def add(a, b):\n    return b + a\n');
    later = await commit('later');
    await git('checkout', '-q', head);
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('opens a review workspace and computes everything the control plane needs in one go', async () => {
    const ws = await openLocalWorkspace({ cloneUrl: repo, baseSha: base, headSha: head }, root);
    try {
      const { info } = ws;
      expect(info.headSha).toBe(head);
      expect(info.trustedSha).toBe(base);
      expect(info.changedFiles.map((f) => f.path).sort()).toEqual(['.winnowl.yaml', 'app.py', 'gen/client.py', 'libs/sub', 'pubspec.yaml']);
      expect(info.headChangedLines['app.py']).toEqual([2]);
      expect(info.nonReviewable).toEqual({ 'gen/client.py': 'generated', 'libs/sub': 'submodule' });
      expect(info.submodules).toEqual([
        {
          path: 'libs/sub',
          sha: 'b'.repeat(40),
          previousSha: 'a'.repeat(40),
          status: 'skipped',
          reason: 'not listed in .gitmodules',
        },
      ]);
      expect(info.skills.map((s) => s.name)).toEqual(['sql-safety']);
      expect(info.manifestPaths).toEqual(['pubspec.yaml']);
    } finally {
      await ws.dispose();
    }
  });

  it('answers code-plane requests over a JSON round trip, batched', async () => {
    const ws = await openLocalWorkspace({ cloneUrl: repo, baseSha: base, headSha: head }, root);
    const client = codePlaneClient(localDispatch(ws));
    try {
      expect(await client.readFiles(['app.py', 'missing.txt'])).toEqual({
        'app.py': 'def add(a, b):\n    return a - b\n',
        'missing.txt': null,
      });
      expect(await client.readTrustedFile('.winnowl.yaml')).toContain('thorough');
      expect((await client.searchCode('return a')).map((h) => h.path)).toEqual(['app.py']);
      expect((await client.changedFilesBetween(base))?.sort()).toEqual(['.winnowl.yaml', 'app.py', 'gen/client.py', 'libs/sub', 'pubspec.yaml']);
      expect(await client.changedFilesBetween('0'.repeat(40))).toBeNull();
      const diffs = await client.diffSince(base, ['app.py', 'pubspec.yaml', 'untouched.txt'], 4000);
      expect(Object.keys(diffs).sort()).toEqual(['app.py', 'pubspec.yaml']);
      expect(diffs['app.py']).toContain('+    return a - b');
      expect((await client.diffSince(base, ['app.py'], 20))['app.py']).toContain('(truncated');
      const patches = await client.readPatches(['app.py', 'pubspec.yaml', 'untouched.txt'], 4000, 100_000);
      expect(patches['app.py']).toBe('--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a + b\n+    return a - b');
      expect(patches['pubspec.yaml']).toContain('+++ b/pubspec.yaml');
      expect(Object.keys(patches).sort()).toEqual(['app.py', 'pubspec.yaml']);
      expect((await client.readPatches(['app.py'], 20, 100_000))['app.py']).toContain('(patch truncated');
      // Past the total cap a large patch is left out while smaller ones still fit.
      expect(Object.keys(await client.readPatches(['app.py', 'pubspec.yaml'], 4000, 80))).toEqual(['pubspec.yaml']);
    } finally {
      await ws.dispose();
    }
  });

  it('a tree workspace checks out one commit and trusts it', async () => {
    const ws = await openLocalWorkspace({ cloneUrl: repo, headSha: base }, root);
    try {
      expect(ws.info.changedFiles).toEqual([]);
      expect(ws.info.trustedSha).toBe(base);
      expect((await ws.handle({ op: 'readFiles', paths: ['app.py'] })) as Record<string, string>).toEqual({
        'app.py': 'def add(a, b):\n    return a + b\n',
      });
    } finally {
      await ws.dispose();
    }
  });

  it('fetches a head that only the PR ref provides, and fails clearly when nothing provides it', async () => {
    // `later` is on no branch of the clone source's default refs but is published under a PR ref.
    await git('update-ref', 'refs/pull/7/head', later);
    const ws = await openLocalWorkspace({ cloneUrl: repo, baseSha: head, headSha: later, headRef: 'refs/pull/7/head' }, root);
    expect(ws.info.headSha).toBe(later);
    await ws.dispose();
    await expect(
      openLocalWorkspace({ cloneUrl: repo, baseSha: head, headSha: 'f'.repeat(40) }, root),
    ).rejects.toBeInstanceOf(WorkspaceHeadMissingError);
  });

  it('the reader caches head files and batches a prefetch into one request', async () => {
    const ws = await openLocalWorkspace({ cloneUrl: repo, baseSha: base, headSha: head }, root);
    const requests: CodePlaneRequest[] = [];
    const dispatch = localDispatch(ws);
    const reader = new CodePlaneReader({
      info: ws.info,
      client: codePlaneClient((req) => {
        requests.push(req);
        return dispatch(req);
      }),
    });
    try {
      await reader.prefetch(['app.py', 'pubspec.yaml']);
      expect(await reader.readFile('app.py')).toContain('return a - b');
      expect(await reader.readHeadLines('pubspec.yaml')).toEqual(['dependencies:', '  http: ^1.0.0', '']);
      expect(requests).toEqual([{ op: 'readFiles', paths: ['app.py', 'pubspec.yaml'] }]);
      expect(reader.isChangedLine('app.py', 2)).toBe(true);
      expect(reader.isChangedLine('app.py', 1)).toBe(false);
      expect(await reader.source.listChangedFiles()).toEqual(ws.info.changedFiles);
    } finally {
      await ws.dispose();
    }
  });

  it('applies a fix patch in the worktree and returns the changes an API commit needs', async () => {
    const ws = await openLocalWorkspace({ cloneUrl: repo, headSha: head }, root);
    const client = codePlaneClient(localDispatch(ws));
    try {
      const patch = ['*** Begin Patch', '*** Update File: app.py', '@@', '-    return a - b', '+    return a + b', '*** End Patch'].join('\n');
      expect(await client.applyPatch(patch)).toEqual([
        { path: 'app.py', mode: '100644', contentBase64: Buffer.from('def add(a, b):\n    return a + b\n').toString('base64') },
      ]);
      expect((await client.readFiles(['app.py']))['app.py']).toContain('return a + b');
      const escape = ['*** Begin Patch', '*** Add File: ../outside.txt', '+x', '*** End Patch'].join('\n');
      await expect(client.applyPatch(escape)).rejects.toThrow(/escapes the tree/);
    } finally {
      await ws.dispose();
    }
  });
});
