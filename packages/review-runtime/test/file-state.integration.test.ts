import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revParse, runGit } from '@reviewbot/git-repository';
import { prepareWorkspace } from '../src/workspace.js';
import { buildReviewContractDigest } from '../src/file-state.js';

describe('incremental review file state', () => {
  let dir: string;
  let worktrees: string;
  let baseSha: string;
  let firstHeadSha: string;
  let secondHeadSha: string;

  const commit = (message: string) =>
    runGit(dir, [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-q',
      '-m',
      message,
    ]);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'review-file-state-'));
    worktrees = await mkdtemp(join(tmpdir(), 'review-file-state-wt-'));
    await runGit(dir, ['init', '-q']);
    await writeFile(join(dir, 'a.ts'), 'export const value = 1;\n');
    await runGit(dir, ['add', '.']);
    await commit('base');
    baseSha = await revParse(dir, 'HEAD');

    await writeFile(join(dir, 'a.ts'), 'export const value = 2;\n');
    await runGit(dir, ['add', '.']);
    await commit('change a');
    firstHeadSha = await revParse(dir, 'HEAD');

    await writeFile(join(dir, 'b.ts'), 'export const other = true;\n');
    await runGit(dir, ['add', '.']);
    await commit('change b');
    secondHeadSha = await revParse(dir, 'HEAD');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(worktrees, { recursive: true, force: true });
  });

  async function states(headSha: string, suffix: string, base = baseSha) {
    const workspace = await prepareWorkspace({
      gitDir: dir,
      baseSha: base,
      headSha,
      headWorktreeDir: join(worktrees, suffix),
    });
    try {
      return workspace.fileStates;
    } finally {
      await workspace.cleanup();
    }
  }

  it('keeps a file stable when a later commit changes only another file', async () => {
    const first = await states(firstHeadSha, 'first');
    const second = await states(secondHeadSha, 'second');
    expect(second.find((file) => file.path === 'a.ts')?.materialDigest).toBe(
      first.find((file) => file.path === 'a.ts')?.materialDigest,
    );
    expect(second.find((file) => file.path === 'b.ts')).toBeDefined();
  });

  it('per-stage models are part of the contract (and are order-insensitive)', () => {
    const base = {
      configDigest: 'config-a',
      promptDigests: [{ role: 'reviewer', digest: 'r' }],
      modelIdentity: { id: 'openai:gpt-x', tier: 'quality' },
    };
    const withDig = buildReviewContractDigest({
      ...base,
      stageModels: [
        { stage: 'dig', models: ['a:strong'] },
        { stage: 'map', models: ['a:cheap', 'a:cheap-2'] },
      ],
    });
    expect(
      buildReviewContractDigest({
        ...base,
        stageModels: [
          { stage: 'map', models: ['a:cheap-2', 'a:cheap'] },
          { stage: 'dig', models: ['a:strong'] },
        ],
      }),
    ).toBe(withDig);
    expect(
      buildReviewContractDigest({
        ...base,
        stageModels: [
          { stage: 'dig', models: ['a:stronger'] },
          { stage: 'map', models: ['a:cheap', 'a:cheap-2'] },
        ],
      }),
    ).not.toBe(withDig);
    expect(buildReviewContractDigest(base)).not.toBe(withDig);
  });

  it('keeps the contract stable across prompt order and invalidates config or prompt changes', () => {
    const first = buildReviewContractDigest({
      configDigest: 'config-a',
      promptDigests: [
        { role: 'reviewer', digest: 'r' },
        { role: 'mapper', digest: 'm' },
      ],
      modelIdentity: { id: 'openai:gpt-x', tier: 'quality' },
    });
    expect(
      buildReviewContractDigest({
        configDigest: 'config-a',
        promptDigests: [
          { role: 'mapper', digest: 'm' },
          { role: 'reviewer', digest: 'r' },
        ],
        modelIdentity: { id: 'openai:gpt-x', tier: 'quality' },
      }),
    ).toBe(first);
    expect(
      buildReviewContractDigest({
        configDigest: 'config-b',
        promptDigests: [
          { role: 'mapper', digest: 'm' },
          { role: 'reviewer', digest: 'r' },
        ],
        modelIdentity: { id: 'openai:gpt-x', tier: 'quality' },
      }),
    ).not.toBe(first);
    expect(
      buildReviewContractDigest({
        configDigest: 'config-a',
        promptDigests: [
          { role: 'mapper', digest: 'changed' },
          { role: 'reviewer', digest: 'r' },
        ],
        modelIdentity: { id: 'openai:gpt-x', tier: 'quality' },
      }),
    ).not.toBe(first);
    expect(
      buildReviewContractDigest({
        configDigest: 'config-a',
        promptDigests: [
          { role: 'mapper', digest: 'm' },
          { role: 'reviewer', digest: 'r' },
        ],
        modelIdentity: { id: 'openai:gpt-x', tier: 'quality' },
        reviewStandard: 'new mandatory repository rule',
      }),
    ).not.toBe(first);
  });

  it('invalidates the contract when the reviewing model or tier changes', () => {
    const base = {
      configDigest: 'config-a',
      promptDigests: [{ role: 'mapper', digest: 'm' }],
    };
    const first = buildReviewContractDigest({
      ...base,
      modelIdentity: { id: 'openai:cheap-model', tier: 'cheap' },
    });
    expect(
      buildReviewContractDigest({
        ...base,
        modelIdentity: { id: 'openai:strong-model', tier: 'cheap' },
      }),
    ).not.toBe(first);
    expect(
      buildReviewContractDigest({
        ...base,
        modelIdentity: { id: 'openai:cheap-model', tier: 'quality' },
      }),
    ).not.toBe(first);
    expect(
      buildReviewContractDigest({
        ...base,
        modelIdentity: { id: 'openai:cheap-model', tier: 'cheap' },
      }),
    ).toBe(first);
  });

  it('changes the digest when the file material changes', async () => {
    await writeFile(join(dir, 'a.ts'), 'export const value = 3;\n');
    await runGit(dir, ['add', '.']);
    await commit('change a again');
    const thirdHeadSha = await revParse(dir, 'HEAD');
    const first = await states(firstHeadSha, 'material-first');
    const third = await states(thirdHeadSha, 'material-third');
    expect(third.find((file) => file.path === 'a.ts')?.materialDigest).not.toBe(
      first.find((file) => file.path === 'a.ts')?.materialDigest,
    );
  });

  it('keeps a file stable when only the review baseline moves', async () => {
    const againstBase = await states(secondHeadSha, 'baseline-base');
    const againstFirstHead = await states(secondHeadSha, 'baseline-moved', firstHeadSha);
    expect(againstBase.find((file) => file.path === 'b.ts')?.materialDigest).toBe(
      againstFirstHead.find((file) => file.path === 'b.ts')?.materialDigest,
    );
  });

  it('records rename, deletion, and binary changes without reading text', async () => {
    await runGit(dir, ['mv', 'b.ts', 'renamed.ts']);
    await runGit(dir, ['rm', 'a.ts']);
    await writeFile(join(dir, 'asset.bin'), Buffer.from([0, 255, 1, 254, 2]));
    await runGit(dir, ['add', '.']);
    await commit('mixed file changes');
    const mixedHeadSha = await revParse(dir, 'HEAD');
    const mixed = await states(mixedHeadSha, 'mixed', secondHeadSha);
    expect(mixed.find((file) => file.path === 'renamed.ts')).toMatchObject({
      oldPath: 'b.ts',
      newPath: 'renamed.ts',
      status: 'renamed',
    });
    expect(mixed.find((file) => file.path === 'a.ts')).toMatchObject({
      oldPath: 'a.ts',
      newPath: null,
      status: 'deleted',
    });
    expect(mixed.find((file) => file.path === 'asset.bin')?.materialDigest).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('removes the worktree when preparation fails after checkout', async () => {
    const worktree = join(dir, 'failed-worktree');
    await expect(
      prepareWorkspace({
        gitDir: dir,
        baseSha: 'missing-base',
        headSha: secondHeadSha,
        headWorktreeDir: worktree,
      }),
    ).rejects.toThrow();
    expect(existsSync(worktree)).toBe(false);
    expect((await runGit(dir, ['worktree', 'list', '--porcelain'])).stdout).not.toContain(worktree);
  });
});
