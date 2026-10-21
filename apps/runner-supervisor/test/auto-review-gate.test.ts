import { describe, expect, it } from 'vitest';
import { repositoryConfigSchema } from '@reviewbot/config';
import { autoReviewSkip, matchesBaseBranch, type AutoReviewGateInput } from '../src/auto-review-gate.js';

const auto = repositoryConfigSchema.parse({}).reviews.auto;
const base: AutoReviewGateInput = {
  state: 'open',
  draft: false,
  author: 'alice',
  authorIsBot: false,
  paused: false,
  targetBranch: 'main',
  effectiveBaseBranch: 'main',
  defaultBranch: 'main',
  labels: [],
  auto,
  isManual: false,
};

describe('matchesBaseBranch', () => {
  it('empty list follows the repository default branch, not a hardcoded main', () => {
    expect(matchesBaseBranch([], 'master', 'master')).toBe(true);
    expect(matchesBaseBranch([], 'main', 'master')).toBe(false);
  });

  it('entries are globs', () => {
    expect(matchesBaseBranch(['main', 'release/*'], 'release/2.0', 'main')).toBe(true);
    expect(matchesBaseBranch(['release/*'], 'release/2.0/hotfix', 'main')).toBe(false);
    expect(matchesBaseBranch(['**'], 'feat/a/b', 'main')).toBe(true);
    expect(matchesBaseBranch(['main'], 'master', 'master')).toBe(false);
  });
});

describe('autoReviewSkip', () => {
  it('announces the reasons a person can act on, and lets manual triggers through them', () => {
    expect(autoReviewSkip({ ...base, draft: true })?.status).toEqual({ code: 'draft' });
    expect(autoReviewSkip({ ...base, draft: true, isManual: true })).toBeNull();
    expect(autoReviewSkip({ ...base, effectiveBaseBranch: 'dev', targetBranch: 'dev' })?.status).toEqual({
      code: 'base-branch',
      branch: 'dev',
      defaultBranch: 'main',
    });
    expect(
      autoReviewSkip({ ...base, effectiveBaseBranch: 'dev', auto: { ...auto, base_branches: ['main'] } })?.status,
    ).toEqual({ code: 'base-branch', branch: 'dev' });
    expect(autoReviewSkip({ ...base, effectiveBaseBranch: 'master', targetBranch: 'master', defaultBranch: 'master' })).toBeNull();
    expect(autoReviewSkip({ ...base, paused: true })?.status).toEqual({ code: 'paused' });
    expect(
      autoReviewSkip({ ...base, auto: { ...auto, required_labels: ['review'] } })?.status,
    ).toEqual({ code: 'labels', required: ['review'] });
  });

  it('stays quiet where a checkbox would not help', () => {
    const closed = autoReviewSkip({ ...base, state: 'merged' });
    expect(closed?.status).toBeUndefined();
    expect(autoReviewSkip({ ...base, state: 'merged', isManual: true })).not.toBeNull();
    expect(autoReviewSkip({ ...base, auto: { ...auto, enabled: false }, isManual: true })?.status).toBeUndefined();
    expect(autoReviewSkip({ ...base, author: 'winnowl[bot]' })?.status).toBeUndefined();
    expect(autoReviewSkip({ ...base, author: 'dependabot[bot]', authorIsBot: true })?.status).toBeUndefined();
    expect(autoReviewSkip(base)).toBeNull();
  });

  // Unknown author (not registered yet): no auto review, or author-based gates would pass silently.
  // Manual triggers are unaffected.
  it('作者未知时 fail closed:不自动评审,manual 照常', () => {
    expect(autoReviewSkip({ ...base, author: null })?.log).toContain('作者尚未登记');
    expect(autoReviewSkip({ ...base, author: null, isManual: true })).toBeNull();
    // Same with an ignore list: an unknown author never passes.
    expect(
      autoReviewSkip({ ...base, author: null, auto: { ...auto, ignore_authors: ['octocat'] } })?.log,
    ).toContain('作者尚未登记');
  });
});
