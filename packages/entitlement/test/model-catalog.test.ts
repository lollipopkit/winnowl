import { describe, expect, it } from 'vitest';
import { MODELS_DEV_SOURCE, parseModelsDev, parseModelsDevEntry } from '../src/model-catalog.js';

// Pins which entries are filtered out (no price, zero context): selecting them would silently miscompute cost.
describe('模型元数据目录:models.dev 映射', () => {
  const chat = {
    name: 'GPT-4o mini',
    reasoning: false,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 128000, output: 16384 },
    cost: { input: 0.15, output: 0.6, cache_read: 0.075 },
  };

  it('取规格四件套 + 价格,并把模态收敛成 text/image', () => {
    const e = parseModelsDevEntry('openai', 'gpt-4o-mini', chat);
    expect(e).toEqual({
      source: MODELS_DEV_SOURCE,
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      name: 'GPT-4o mini',
      contextWindow: 128000,
      maxTokens: 16384,
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0.15, output: 0.6, cacheRead: 0.075 },
    });
  });

  it('没有输入/输出单价 → 不收(否则成本恒算成 0,而成本闸读的就是这个数)', () => {
    expect(parseModelsDevEntry('x', 'm', { ...chat, cost: { output: 1 } })).toBeUndefined();
    expect(parseModelsDevEntry('x', 'm', { ...chat, cost: { input: 1 } })).toBeUndefined();
    expect(parseModelsDevEntry('x', 'm', { ...chat, cost: {} })).toBeUndefined();
  });

  it('上下文或输出上限为 0 → 不收(多是图像/嵌入条目,当聊天模型用会一开跑就判超预算)', () => {
    expect(parseModelsDevEntry('x', 'm', { ...chat, limit: { context: 0, output: 4096 } })).toBeUndefined();
    expect(parseModelsDevEntry('x', 'm', { ...chat, limit: { context: 128000, output: 0 } })).toBeUndefined();
  });

  it('缺 name 用 modelId;缺 modalities 当纯文本;reasoning 只认 true', () => {
    const e = parseModelsDevEntry('deepseek', 'deepseek-chat', {
      limit: { context: 64000, output: 8192 },
      cost: { input: 0.27, output: 1.1 },
    });
    expect(e).toMatchObject({ name: 'deepseek-chat', input: ['text'], reasoning: false });
  });

  it('整份解析跳过坏条目,不因为一条缺字段丢掉整个 provider', () => {
    const out = parseModelsDev({
      openai: { models: { good: chat, bad: { ...chat, cost: {} } } },
      broken: { models: null },
      alsoBroken: 'not an object',
    });
    expect(out.map((e) => `${e.provider}/${e.modelId}`)).toEqual(['openai/good']);
  });

  it('非对象输入返回空数组而不是抛(上游返回 HTML 错误页时不该炸掉同步)', () => {
    expect(parseModelsDev(null)).toEqual([]);
    expect(parseModelsDev('<html>')).toEqual([]);
  });
});
