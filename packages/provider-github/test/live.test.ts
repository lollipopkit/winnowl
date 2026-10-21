import { describe, expect, it } from 'vitest';
import { RestClient } from '@reviewbot/provider-http';
import { GithubProvider } from '../src/index.js';

/**
 * Live contract smoke test, skipped by default.
 *
 * Read-only, enabled when set:
 *   REVIEWBOT_LIVE_GITHUB_TOKEN   fine-grained PAT (Contents R, Pull requests R, Issues R, Metadata R)
 *   REVIEWBOT_LIVE_GITHUB_REPO    owner/name (private test repo)
 *   REVIEWBOT_LIVE_GITHUB_PR      a PR number in that repo
 * Optional:
 *   REVIEWBOT_LIVE_GITHUB_ISSUE   an issue number (issues.get)
 *   REVIEWBOT_LIVE_GITHUB_API     GHES API base (default https://api.github.com)
 *   REVIEWBOT_LIVE_GITHUB_WRITE=1 side-effect smoke test (PAT needs Issues R/W)
 */
const token = process.env.REVIEWBOT_LIVE_GITHUB_TOKEN;
const repo = process.env.REVIEWBOT_LIVE_GITHUB_REPO;
const prNumber = process.env.REVIEWBOT_LIVE_GITHUB_PR;
const issueNumber = process.env.REVIEWBOT_LIVE_GITHUB_ISSUE;
const writeEnabled = process.env.REVIEWBOT_LIVE_GITHUB_WRITE === '1';
const baseUrl = process.env.REVIEWBOT_LIVE_GITHUB_API ?? 'https://api.github.com';
const enabled = Boolean(token && repo && prNumber);

const [owner, name] = (repo ?? '/').split('/');
const REPO_REF = {
  id: 'live-repo',
  providerHostId: 'live',
  installationId: 'live',
  nativeId: 'live',
  namespace: owner ?? '',
  name: name ?? '',
  cloneUrl: `https://github.com/${repo}.git`,
  defaultBranch: 'main',
};
const CR_REF = { id: 'live-cr', repositoryId: 'live-repo', nativeId: 'live', number: Number(prNumber), kind: 'pull-request' as const };

function makeProvider(): GithubProvider {
  return new GithubProvider({
    client: new RestClient({ baseUrl, authorization: () => `token ${token}` }),
    host: { id: 'live', provider: 'github', baseUrl, apiUrl: baseUrl, isSaas: true },
    resolveRepo: () => ({ owner: owner ?? '', repo: name ?? '' }),
  });
}

describe.skipIf(!enabled)('GitHub live 契约(只读)', () => {
  const provider = enabled ? makeProvider() : (undefined as unknown as GithubProvider);

  it('identity.botActor → 当前身份', async () => {
    const actor = await provider.identity.botActor();
    expect(actor.login).toBeTruthy();
  });

  it('changes.get → canonical ChangeRequest', async () => {
    const cr = await provider.changes.get(CR_REF);
    expect(typeof cr.title).toBe('string');
    expect(['open', 'closed', 'merged']).toContain(cr.state);
    expect(cr.revision.headSha).toBeTruthy();
  });

  it('changes.listChangedFiles / getProviderDiff / listCommits', async () => {
    const files = await provider.changes.listChangedFiles(CR_REF);
    expect(Array.isArray(files)).toBe(true);
    const diff = await provider.changes.getProviderDiff(CR_REF);
    expect(typeof diff.raw).toBe('string');
    const commits = await provider.changes.listCommits(CR_REF);
    expect(commits.length).toBeGreaterThan(0);
  });

  it('pipelines.listRuns → 数组(可空);有 run 则 getJobs 可用', async () => {
    const runs = await provider.pipelines.listRuns(CR_REF);
    expect(Array.isArray(runs)).toBe(true);
    if (runs.length > 0) {
      const jobs = await provider.pipelines.getJobs(runs[0]!.ref);
      expect(Array.isArray(jobs)).toBe(true);
    }
  });

  it.skipIf(!issueNumber)('issues.get → 标题/正文', async () => {
    const issue = await provider.issues.get(REPO_REF, Number(issueNumber));
    expect(typeof issue.title).toBe('string');
    expect(issue.number).toBe(Number(issueNumber));
  });
});

describe.skipIf(!(enabled && writeEnabled))('GitHub live 契约(副作用)', () => {
  const provider = enabled ? makeProvider() : (undefined as unknown as GithubProvider);

  it('issues.create → issues.get 往返 + comment', async () => {
    const receipt = await provider.issues.create(
      REPO_REF,
      { title: `winnowl live smoke ${Date.now()}`, body: { markdown: 'live contract smoke test' }, labels: ['reviewbot'] },
      { key: `live-issue-${Date.now()}` },
    );
    expect(receipt.ref.number).toBeGreaterThan(0);
    const fetched = await provider.issues.get(REPO_REF, receipt.ref.number);
    expect(fetched.title).toContain('winnowl live smoke');
    const comment = await provider.issues.comment(receipt.ref, { markdown: 'auto-comment' }, { key: `live-c-${Date.now()}` });
    expect(comment.nativeId).toBeTruthy();
  });

  it('discussions.createTopLevelComment on PR', async () => {
    const rc = await provider.discussions.createTopLevelComment(
      { kind: 'change-request', ref: CR_REF },
      { markdown: `winnowl live top-level ${Date.now()}` },
      { key: `live-tl-${Date.now()}` },
    );
    expect(rc.nativeId).toBeTruthy();
  });

  // changes.create needs a pushed head branch: set REVIEWBOT_LIVE_GITHUB_HEAD_BRANCH.
  it.skipIf(!process.env.REVIEWBOT_LIVE_GITHUB_HEAD_BRANCH)('changes.create → 开 PR(§28.4)', async () => {
    const head = process.env.REVIEWBOT_LIVE_GITHUB_HEAD_BRANCH as string;
    const receipt = await provider.changes.create(
      REPO_REF,
      { title: `reviewbot stacked ${Date.now()}`, body: { markdown: 'stacked CR live smoke' }, sourceBranch: head, targetBranch: 'main' },
      { key: `live-cr-${Date.now()}` },
    );
    expect(receipt.ref.number).toBeGreaterThan(0);
    expect(receipt.ref.kind).toBe('pull-request');
    expect(receipt.url).toContain('/pull/');
  });
});
