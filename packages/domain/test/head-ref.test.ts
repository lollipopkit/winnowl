import { describe, expect, it } from 'vitest';
import { changeRequestHeadRef } from '../src/index.js';

describe('changeRequestHeadRef(fork PR 取 head)', () => {
  it('GitHub / Forgejo 用 refs/pull/<n>/head', () => {
    expect(changeRequestHeadRef('github', 38)).toBe('refs/pull/38/head');
    expect(changeRequestHeadRef('forgejo', 38)).toBe('refs/pull/38/head');
  });

  it('GitLab 用 refs/merge-requests/<n>/head', () => {
    expect(changeRequestHeadRef('gitlab', 7)).toBe('refs/merge-requests/7/head');
  });

  it('未实现适配器的 provider → undefined,不猜', () => {
    expect(changeRequestHeadRef('bitbucket', 1)).toBeUndefined();
    expect(changeRequestHeadRef('azure-devops', 1)).toBeUndefined();
  });
});
