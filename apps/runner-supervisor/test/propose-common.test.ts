import { describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import { findingsDigest, newUsage, resolveProposeNearDup } from '../src/propose-common.js';

describe('propose-common(三链路公共骨架)', () => {
  it('findingsDigest:空 → 占位;非空 → 每行 [category/severity] claim', () => {
    expect(findingsDigest([])).toBe('(no findings)');
    expect(findingsDigest([{ claim: 'x', category: 'correctness', severity: 'high' }])).toBe('- [correctness/high] x');
  });

  it('resolveProposeNearDup:token/未设 → 恒 false(仅精确等值,不做语义判重)', async () => {
    const check = resolveProposeNearDup({ usage: newUsage() }, { LLM_DEDUP: 'token' } as NodeJS.ProcessEnv);
    expect(await check('a rule', ['a rule paraphrased'])).toBe(false);
    const unset = resolveProposeNearDup({ usage: newUsage() }, {} as NodeJS.ProcessEnv);
    expect(await unset('a', ['a'])).toBe(false);
  });

  it('resolveProposeNearDup:未知模式 / embedding 缺配置 / llm 缺模型源 → 显式抛错', () => {
    expect(() => resolveProposeNearDup({ usage: newUsage() }, { LLM_DEDUP: 'bogus' } as NodeJS.ProcessEnv)).toThrow(/未知 LLM_DEDUP/);
    expect(() => resolveProposeNearDup({ usage: newUsage() }, { LLM_DEDUP: 'embedding' } as NodeJS.ProcessEnv)).toThrow(/LLM_BASE_URL/);
    expect(() => resolveProposeNearDup({ usage: newUsage() }, { LLM_DEDUP: 'llm' } as NodeJS.ProcessEnv)).toThrow(/cheap/);
  });

  it('resolveProposeNearDup(llm):judge 判 duplicate → true;既有集为空 → 不调模型直接 false', async () => {
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('submit_dedup', { duplicate: true }))]);
    const usage = newUsage();
    const check = resolveProposeNearDup({ cheapSource: { model: faux.model, streamFn: faux.streamFn }, usage }, { LLM_DEDUP: 'llm' } as NodeJS.ProcessEnv);
    expect(await check('rule A', [])).toBe(false); // an empty set costs nothing
    expect(await check('rule A', ['rule A worded differently'])).toBe(true);
  });
});
