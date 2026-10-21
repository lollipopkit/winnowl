import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPatchToTree, collectTreeChanges, deliverStackedChangeRequest } from '@reviewbot/autofix';
import type { ChangeRequestRef, RepositoryRef } from '@reviewbot/domain';
import { runGit } from '@reviewbot/git-repository';
import { GithubProvider } from '@reviewbot/provider-github';
import { RestClient } from '@reviewbot/provider-http';
import { authedCloneUrl, cloneRepository } from '@reviewbot/review-runtime';

const token = process.env.REVIEWBOT_LIVE_GITHUB_TOKEN;
const repoSlug = process.env.REVIEWBOT_LIVE_GITHUB_REPO;
const prNumber = process.env.REVIEWBOT_LIVE_GITHUB_PR;
const baseUrl = process.env.REVIEWBOT_LIVE_GITHUB_API ?? 'https://api.github.com';
const [owner, name] = (repoSlug ?? '/').split('/');
const enabled = Boolean(token && repoSlug && prNumber);

// Fixed src/math.js of feature/mul (mul multiplies, lastItem uses length-1).
const FIXED = `export function add(a, b) {
  return a + b;
}

export function mul(a, b) {
  return a * b;
}

export function lastItem(arr) {
  return arr[arr.length - 1];
}
`;

describe.skipIf(!enabled)('Fix Pipeline live:stacked CR 交付(§28.4,API 提交)', () => {
  let gitDir: string;
  let cloneRoot: string;
  let headSha: string;
  let sourceBranch: string;
  let provider: GithubProvider;
  const repoRef: RepositoryRef = { id: 'live', providerHostId: 'live', installationId: 'live', nativeId: 'live', namespace: owner ?? '', name: name ?? '', cloneUrl: `https://github.com/${repoSlug}.git`, defaultBranch: 'main' };

  beforeAll(async () => {
    provider = new GithubProvider({
      client: new RestClient({ baseUrl, authorization: () => `token ${token}` }),
      host: { id: 'live', provider: 'github', baseUrl, apiUrl: baseUrl, isSaas: true },
      resolveRepo: () => ({ owner: owner ?? '', repo: name ?? '' }),
    });
    const crRef: ChangeRequestRef = { id: 'live', repositoryId: 'live', nativeId: 'live', number: Number(prNumber), kind: 'pull-request' };
    const cr = await provider.changes.get(crRef);
    headSha = cr.revision.headSha;
    sourceBranch = cr.revision.sourceBranch; // feature/mul

    cloneRoot = await mkdtemp(join(tmpdir(), 'live-autofix-'));
    gitDir = await cloneRepository(authedCloneUrl(`https://github.com/${repoSlug}.git`, token as string), join(cloneRoot, 'repo'));
  }, 120_000);

  afterAll(async () => {
    if (cloneRoot) await rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('PR Head 的工作树里应用 patch → 经 Git Data API 提交到 bot 分支 → 开 stacked CR', async () => {
    // Build an exact patch with git: write the fixed file, git diff, restore.
    await runGit(gitDir, ['checkout', sourceBranch]);
    await writeFile(join(gitDir, 'src/math.js'), FIXED, 'utf8');
    const patch = (await runGit(gitDir, ['diff'])).stdout;
    await runGit(gitDir, ['checkout', '--', 'src/math.js']);
    expect(patch).toContain('src/math.js');

    // What the workspace does on a sandbox host: apply in the head worktree, read the changes.
    await runGit(gitDir, ['checkout', '--detach', headSha]);
    await applyPatchToTree(gitDir, patch, (dir, args) => runGit(dir, args));
    const changes = await collectTreeChanges(gitDir, (dir, args) => runGit(dir, args));
    expect(changes.map((c) => c.path)).toEqual(['src/math.js']);

    const branch = `winnowl/${prNumber}/autofix-live-${Date.now()}`;
    const result = await deliverStackedChangeRequest(
      {
        commitChanges: (input) => provider.commits.commitChanges(repoRef, input),
        openChangeRequest: async (input) => {
          const receipt = await provider.changes.create(
            repoRef,
            { title: input.title, body: { markdown: input.body }, sourceBranch: input.sourceBranch, targetBranch: input.targetBranch },
            { key: `live-stacked-${Date.now()}` },
          );
          return { number: receipt.ref.number, ...(receipt.url ? { url: receipt.url } : {}) };
        },
      },
      {
        changes,
        branch,
        baseSha: headSha,
        targetBranch: sourceBranch, // stacked on the PR source branch
        title: 'reviewbot: fix mul/lastItem (autofix live)',
        body: 'Stacked autofix over the review findings.',
        botIdentity: { name: 'winnowl', email: 'winnowl@users.noreply.github.com' },
      },
    );

    expect(result.branch).toBe(branch);
    expect(result.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.changeRequest.number).toBeGreaterThan(0);
    console.log('[live-autofix] opened stacked CR #', result.changeRequest.number, result.changeRequest.url, 'branch', branch);
  }, 120_000);
});
