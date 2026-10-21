import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '@reviewbot/config';
import {
  assertPromptDigestParity,
  buildProduceDeps,
  type ReviewExecutorSpec,
} from '../src/executor-spec.js';

describe('buildProduceDeps(executor-spec 反序列化)', () => {
  let worktree: string;

  beforeAll(() => {
    worktree = mkdtempSync(join(tmpdir(), 'rvb-exec-spec-'));
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src/a.ts'), 'line1\nline2\nline3\n');
  });

  afterAll(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  const baseSpec = (): ReviewExecutorSpec => ({
    revisionSha: 'deadbeef',
    revisionId: 'rev-fixed',
    changedFiles: [{ path: 'src/a.ts', status: 'modified' }],
    headChangedLines: { 'src/a.ts': [2, 3] },
    model: { provider: 'openai', modelId: 'gpt-4o', apiKey: 'sk-test' },
    budget: { maxTurns: 10, maxToolCalls: 20 },
    promptDigests: [],
  });

  it('fails closed when prompt identities are absent or mismatched', () => {
    const loaded = [{ role: 'mapper', digest: 'current' }];
    expect(() => assertPromptDigestParity(undefined, loaded)).toThrow('digests are required');
    expect(() => assertPromptDigestParity([{ role: 'mapper', digest: 'stale' }], loaded)).toThrow(
      'prompt mismatch for mapper',
    );
    expect(() =>
      assertPromptDigestParity(
        [
          { role: 'mapper', digest: 'current' },
          { role: 'unexpected', digest: 'current' },
        ],
        loaded,
      ),
    ).toThrow('digest set does not match');
    expect(() =>
      assertPromptDigestParity([{ role: 'mapper', digest: 'current' }], loaded),
    ).not.toThrow();
  });

  it('重建 source / readHeadLines,读回挂载 worktree 内容', async () => {
    const { deps } = buildProduceDeps({
      spec: baseSpec(),
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(await deps.source.readFile('src/a.ts')).toBe('line1\nline2\nline3\n');
    expect(await deps.readHeadLines!('src/a.ts')).toEqual(['line1', 'line2', 'line3', '']);
  });

  // Every cost knob must reach the sandbox; spread properties escape excess-property checks.
  it('花钱的旋钮(成本闸 / 各阶段墙钟)必须随 spec 进沙盒', () => {
    const spec: ReviewExecutorSpec = {
      ...baseSpec(),
      costCapUsd: 3,
      stageBudgetMs: { map: 300_000, dig: 900_000, synthesis: 180_000 },
      verifyBudgetMs: 540_000,
    };
    const { deps } = buildProduceDeps({
      spec,
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(deps.costCapUsd).toBe(3);
    expect(deps.stageBudgetMs).toEqual({ map: 300_000, dig: 900_000, synthesis: 180_000 });
    expect(deps.verifyBudgetMs).toBe(540_000);
  });

  it('阶段模型随 spec 进沙盒,并按算法选出模型', () => {
    // Uncataloged model ids need a template model of the same api.
    const two = [
      { provider: 'openai', modelId: 'a', apiKey: 'sk-a', templateModelId: 'gpt-4o' },
      { provider: 'openai', modelId: 'b', apiKey: 'sk-b', templateModelId: 'gpt-4o' },
    ];
    const spec: ReviewExecutorSpec = {
      ...baseSpec(),
      stageModels: [{ stage: 'dig', strategy: 'round-robin', models: two }],
    };
    const { deps } = buildProduceDeps({
      spec,
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(deps.stageModel).toBeDefined();
    expect([0, 1, 2].map((i) => deps.stageModel!('dig', i)?.model.id)).toEqual(['a', 'b', 'a']);
    // Unconfigured stages fall back to spec.model.
    expect(deps.stageModel!('map', 0)).toBeUndefined();
    // Fallbacks are the stage's other models.
    expect(deps.stageModel!('dig', 0)?.fallbackModels?.map((m) => m.id)).toEqual(['b']);
  });

  it('未设阶段模型 → 不注入解析器(全程用 spec.model)', () => {
    const { deps } = buildProduceDeps({
      spec: baseSpec(),
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(deps.stageModel).toBeUndefined();
  });

  it('未设成本闸 → 不注入(默认不限,与今天行为一致)', () => {
    const { deps } = buildProduceDeps({
      spec: baseSpec(),
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(deps.costCapUsd).toBeUndefined();
  });

  it('keeps the configured LLM deduper instead of silently falling back to token Dice', () => {
    const { deps } = buildProduceDeps({
      spec: { ...baseSpec(), dedup: { kind: 'llm' } },
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(deps.dedupStrategy?.kind).toBe('batch');
  });

  it('skips malformed stage model configs while preserving usable candidates', () => {
    const { deps } = buildProduceDeps({
      spec: {
        ...baseSpec(),
        stageModels: [
          {
            stage: 'dig',
            strategy: 'round-robin',
            models: [
              { provider: 'missing', modelId: 'unavailable' },
              { provider: 'openai', modelId: 'usable', apiKey: 'sk', templateModelId: 'gpt-4o' },
            ],
          },
        ],
      },
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(deps.stageModel?.('dig', 0)?.model.id).toBe('usable');
  });

  it('isChangedLine 只对 spec.headChangedLines 命中', () => {
    const { deps } = buildProduceDeps({
      spec: baseSpec(),
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(deps.isChangedLine!('src/a.ts', 2)).toBe(true);
    expect(deps.isChangedLine!('src/a.ts', 3)).toBe(true);
    expect(deps.isChangedLine!('src/a.ts', 1)).toBe(false);
    expect(deps.isChangedLine!('other.ts', 2)).toBe(false);
  });

  it('透传 budget/revisionSha,publish-only 字段给无害 stub', () => {
    const spec = baseSpec();
    const { deps, pluginCalls } = buildProduceDeps({
      spec,
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(deps.budget).toEqual(spec.budget);
    expect(deps.publishTarget.revisionSha).toBe('deadbeef');
    expect(deps.publishTarget.expectedHeadSha).toBe('deadbeef');
    expect(pluginCalls).toEqual([]);
    expect(deps.noiseBudget.maxInlineComments).toBeGreaterThan(1_000_000);
  });

  it('无 memoryEntries/plugins 时不挂 memoryTools/pluginTools', () => {
    const { deps } = buildProduceDeps({
      spec: baseSpec(),
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(deps.memoryTools).toBeUndefined();
    expect(deps.pluginTools).toBeUndefined();
  });

  it('平台插件 key 只经 spec.platformEnv 进来,不读沙盒自己的 env', () => {
    const toolNames = (platformEnv?: Record<string, string>) =>
      buildProduceDeps({
        spec: { ...baseSpec(), plugins: { config: defaultConfig().plugins, ...(platformEnv ? { platformEnv } : {}) } },
        worktreePath: worktree,
        bundles: {} as never,
        newId: () => 'id',
      }).deps.pluginTools?.map((t) => t.name);
    const prev = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = 'leaked-into-sandbox-env';
    try {
      expect(toolNames()).not.toContain('web_search');
    } finally {
      if (prev === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = prev;
    }
    expect(toolNames({ EXA_API_KEY: 'pk' })).toEqual(['web_search', 'fetch_url', 'resolve_library_id', 'query_docs', 'lookup_package']);
  });

  it('增量文件状态和空 uncovered 清单完整穿过 sandbox spec', () => {
    const spec: ReviewExecutorSpec = {
      ...baseSpec(),
      uncoveredPaths: [],
      priorReviewedPaths: ['src/old.ts'],
      reviewFileStates: [{ path: 'src/a.ts', materialDigest: 'a'.repeat(64) }],
      reviewContractDigest: 'b'.repeat(64),
    };
    const { deps } = buildProduceDeps({
      spec,
      worktreePath: worktree,
      bundles: {} as never,
      newId: () => 'id',
    });
    expect(deps.uncoveredPaths).toEqual([]);
    expect(deps.priorReviewedPaths).toEqual(['src/old.ts']);
    expect(deps.reviewFileStates).toEqual(spec.reviewFileStates);
    expect(deps.reviewContractDigest).toBe(spec.reviewContractDigest);
  });

  // The sandbox must seed `random` like the control plane (revisionId), or the two pick different models.
  it('阶段模型分配用 spec.revisionId 当种子(不是 revisionSha)', () => {
    const models = [
      { provider: 'openai', modelId: 'gpt-4o', apiKey: 'sk-test' },
      { provider: 'openai', modelId: 'gpt-4o-mini', apiKey: 'sk-test' },
    ];
    const specWith = (revisionId: string, revisionSha: string): ReviewExecutorSpec => ({
      ...baseSpec(),
      revisionId,
      revisionSha,
      stageModels: [{ stage: 'map', strategy: 'random', models }],
    });
    const pickOf = (spec: ReviewExecutorSpec): string | undefined =>
      buildProduceDeps({ spec, worktreePath: worktree, bundles: {} as never, newId: () => 'id' }).deps.stageModel?.(
        'map',
        0,
      )?.model.id;

    // Find two seeds that pick different models, proving the seed matters.
    let differing: [string, string] | undefined;
    for (let i = 0; i < 40 && !differing; i += 1) {
      for (let j = i + 1; j < 40 && !differing; j += 1) {
        const a = `rev-${i}`;
        const b = `rev-${j}`;
        if (pickOf(specWith(a, 'sha-fixed')) !== pickOf(specWith(b, 'sha-fixed'))) differing = [a, b];
      }
    }
    expect(differing).toBeDefined();
    const [a, b] = differing!;
    expect(pickOf(specWith(a, 'sha-fixed'))).not.toBe(pickOf(specWith(b, 'sha-fixed')));
    // Changing only revisionSha keeps the pick.
    expect(pickOf(specWith(a, 'sha-other'))).toBe(pickOf(specWith(a, 'sha-fixed')));
  });
});
