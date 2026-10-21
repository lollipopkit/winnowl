import { describe, expect, it } from 'vitest';
import { fetchUpstreamModels, parseUpstreamModels, UpstreamModelsUnavailableError } from '../src/index.js';

// Parsing must tolerate malformed entries, and failures must surface so the UI can fall back to manual entry.
describe('parseUpstreamModels', () => {
  it('三种响应形状都认:{data}、{models}、裸数组', () => {
    const one = [{ id: 'a' }];
    expect(parseUpstreamModels({ data: one }).map((m) => m.id)).toEqual(['a']);
    expect(parseUpstreamModels({ models: one }).map((m) => m.id)).toEqual(['a']);
    expect(parseUpstreamModels(one).map((m) => m.id)).toEqual(['a']);
  });

  it('按 id 升序 —— 网关给的顺序不稳定,而这是给人扫读的列表', () => {
    expect(parseUpstreamModels({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'mid' }] }).map((m) => m.id)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('畸形/重复条目跳过,不让整列表报废', () => {
    const got = parseUpstreamModels({ data: [{ id: 'a' }, { id: '' }, {}, null, { id: '  ' }, { id: 'a' }, { id: 'b', owned_by: 'x' }] });
    expect(got).toEqual([{ id: 'a' }, { id: 'b', ownedBy: 'x' }]);
  });

  it('认不出的整体形状 → 空列表(上层据此退回手填)', () => {
    expect(parseUpstreamModels(null)).toEqual([]);
    expect(parseUpstreamModels({ oops: 1 })).toEqual([]);
  });
});

describe('fetchUpstreamModels', () => {
  const env = { LLM_BASE_URL: 'https://gw.example/v1/', LLM_API_KEY: 'k', LLM_PROVIDER: 'openai' } as NodeJS.ProcessEnv;

  it('拉到清单,并带上注册表该填的 provider(界面不必再问一遍)', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const fake = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = String((init?.headers as Record<string, string>)?.authorization ?? '');
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm2' }, { id: 'm1' }] }) };
    }) as unknown as typeof fetch;
    const r = await fetchUpstreamModels(env, fake);
    // A trailing slash on base must not produce //models
    expect(seenUrl).toBe('https://gw.example/v1/models');
    expect(seenAuth).toBe('Bearer k');
    expect(r.items.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(r.defaultProvider).toBe('openai');
  });

  it('非 2xx → 抛可被上层降级的错误(带上状态码)', async () => {
    const fake = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchUpstreamModels(env, fake)).rejects.toBeInstanceOf(UpstreamModelsUnavailableError);
  });

  it('没配 LLM_BASE_URL → 直接抛,不去猜一个端点', async () => {
    await expect(fetchUpstreamModels({} as NodeJS.ProcessEnv, (() => undefined) as unknown as typeof fetch)).rejects.toThrow(/LLM_BASE_URL/);
  });

  it('网络层失败 → 同一种错误(上层只需要「拉不到」这一个分支)', async () => {
    const fake = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(fetchUpstreamModels(env, fake)).rejects.toBeInstanceOf(UpstreamModelsUnavailableError);
  });
});
