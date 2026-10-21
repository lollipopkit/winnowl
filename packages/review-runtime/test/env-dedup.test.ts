import { describe, expect, it } from 'vitest';
import type { Model, StreamFn } from '@reviewbot/agent-pi';
import { resolveDedupStrategy } from '../src/env.js';

const fakeModel = { model: {} as Model<string>, streamFn: (() => {}) as unknown as StreamFn };
const budget = { maxTurns: 4, maxToolCalls: 8 };

describe('resolveDedupStrategy(§加速#2:env → 去重策略)', () => {
  it('未设 / token → undefined(orchestrator 默认 token-Dice)', () => {
    expect(resolveDedupStrategy(fakeModel, budget, {})).toBeUndefined();
    expect(resolveDedupStrategy(fakeModel, budget, { LLM_DEDUP: 'token' })).toBeUndefined();
    expect(resolveDedupStrategy(fakeModel, budget, { LLM_DEDUP: '  TOKEN ' })).toBeUndefined();
  });

  it('llm → batch 策略', () => {
    expect(resolveDedupStrategy(fakeModel, budget, { LLM_DEDUP: 'llm' })?.kind).toBe('batch');
  });

  it('embedding(端点+模型+白名单齐)→ incremental 策略', () => {
    const env = {
      LLM_DEDUP: 'embedding',
      LLM_BASE_URL: 'https://cpa.example/v1',
      LLM_API_KEY: 'k',
      LLM_EMBED_MODEL: 'text-embedding-x',
      LLM_PROVIDER: 'openai',
      LLM_ALLOWED_BASE_URLS: 'https://cpa.example',
    };
    expect(resolveDedupStrategy(fakeModel, budget, env)?.kind).toBe('incremental');
  });

  it('embedding 缺 LLM_EMBED_MODEL → 抛错', () => {
    expect(() =>
      resolveDedupStrategy(fakeModel, budget, { LLM_DEDUP: 'embedding', LLM_BASE_URL: 'https://cpa.example', LLM_API_KEY: 'k' }),
    ).toThrow(/embedding/);
  });

  it('embedding 端点未在 ZDR 白名单 → 抛错(fail-closed)', () => {
    const env = {
      LLM_DEDUP: 'embedding',
      LLM_BASE_URL: 'https://evil.example',
      LLM_API_KEY: 'k',
      LLM_EMBED_MODEL: 'e',
      LLM_PROVIDER: 'openai',
      // Without LLM_ALLOWED_BASE_URLS a custom endpoint is rejected.
    };
    expect(() => resolveDedupStrategy(fakeModel, budget, env)).toThrow();
  });

  it('未知值 → 抛错(不静默降级)', () => {
    expect(() => resolveDedupStrategy(fakeModel, budget, { LLM_DEDUP: 'bogus' })).toThrow(/未知/);
  });
});
