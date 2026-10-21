import { describe, expect, it } from 'vitest';
import { assertModelEndpointAllowed, createModelSource, MAX_OUTPUT_TOKENS_PER_REQUEST, ModelEndpointNotAllowedError, resolveModelSourceFromEnv } from '../src/index.js';

describe('createModelSource', () => {
  // Proxy gateways reject OpenAI's prompt_cache_options; official endpoints keep the catalog compat.
  it('自定义 baseUrl → 关掉 explicit prompt cache mode;官方端点保留目录值', () => {
    const official = createModelSource({ provider: 'openai', modelId: 'gpt-6-luna' });
    const compatOf = (m: unknown) => (m as { compat?: { supportsExplicitPromptCacheMode?: boolean } }).compat;
    expect(compatOf(official.model)?.supportsExplicitPromptCacheMode).toBe(true);
    const proxied = createModelSource({ provider: 'openai', modelId: 'gpt-6-luna', baseUrl: 'https://gw.local/v1' });
    expect(compatOf(proxied.model)?.supportsExplicitPromptCacheMode).toBe(false);
  });

  it('目录模型 + 覆盖 baseUrl,产出 model + streamFn', () => {
    const src = createModelSource({ provider: 'openai', modelId: 'gpt-4o', baseUrl: 'https://my-llm.local/v1', apiKey: 'sk-x' });
    expect(src.model.id).toBe('gpt-4o');
    expect(src.model.baseUrl).toBe('https://my-llm.local/v1');
    expect(typeof src.streamFn).toBe('function');
  });

  it('自定义 modelId + 模板 → 覆盖 id/baseUrl', () => {
    const src = createModelSource({ provider: 'openai', modelId: 'my-custom-model', templateModelId: 'gpt-4o', baseUrl: 'https://x/v1' });
    expect(src.model.id).toBe('my-custom-model');
    expect(src.model.baseUrl).toBe('https://x/v1');
    expect(src.model.api).toBeTruthy();
  });

  it('未知模型且无模板无规格 → 明确报错', () => {
    expect(() => createModelSource({ provider: 'openai', modelId: 'nonexistent-xyz' })).toThrow(/未知模型/);
  });

  // Explicit metadata must win over a same-named catalog entry, and prices are replaced wholesale (no carrier tiers).
  const md = {
    contextWindow: 64000,
    maxTokens: 8192,
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0.27, output: 1.1 },
  };

  it('目录外的模型:靠规格跑起来,协议取自同 provider 的载体', () => {
    const src = createModelSource({ provider: 'openai', modelId: 'deepseek-v4-flash', metadata: md });
    expect(src.model.id).toBe('deepseek-v4-flash');
    expect(src.model.api).toBeTruthy();
    expect(src.model.contextWindow).toBe(64000);
    expect(src.model.maxTokens).toBe(8192);
    expect(src.model.cost.input).toBe(0.27);
    expect(src.model.cost.output).toBe(1.1);
  });

  // Reseller specs can exceed the gateway's max_tokens limit, failing every request with a 400.
  it('单次输出上限截到 128K:规格里的数字来自别家转售商,不是我们走的网关', () => {
    const src = createModelSource({ provider: 'openai', modelId: 'deepseek-v4.1-flash', metadata: { ...md, maxTokens: 943_718 } });
    expect(src.model.maxTokens).toBe(MAX_OUTPUT_TOKENS_PER_REQUEST);
    expect(createModelSource({ provider: 'openai', modelId: 'gpt-6-luna' }).model.maxTokens).toBe(128_000);
  });

  it('目录里有同名条目时,显式规格仍然赢(挑了就按挑的算)', () => {
    const builtin = createModelSource({ provider: 'openai', modelId: 'gpt-4o' });
    expect(builtin.model.contextWindow).not.toBe(64000);
    const src = createModelSource({ provider: 'openai', modelId: 'gpt-4o', metadata: md });
    expect(src.model.contextWindow).toBe(64000);
    expect(src.model.cost.input).toBe(0.27);
  });

  it('缓存价缺失按输入原价算,并丢掉载体的阶梯价 —— 成本闸宁可早关也不该低估', () => {
    const src = createModelSource({ provider: 'openai', modelId: 'x-model', metadata: md });
    expect(src.model.cost.cacheRead).toBe(0.27);
    expect(src.model.cost.cacheWrite).toBe(0.27);
    expect(src.model.cost.tiers).toBeUndefined();
  });

  it('丢掉载体的 thinking 档位映射:那是另一个模型的档位名,发过去会被端点拒', () => {
    const carrier = createModelSource({ provider: 'openai', modelId: 'gpt-4o' });
    const src = createModelSource({ provider: 'openai', modelId: 'x-model', metadata: { ...md, reasoning: true } });
    expect(src.model.thinkingLevelMap).toBeUndefined();
    expect(carrier.model.id).toBe('gpt-4o');
  });

  it('规格里的 input 决定模态 —— 不收图的模型不会被派去读 PR 图片', () => {
    const textOnly = createModelSource({ provider: 'openai', modelId: 'x1', metadata: md });
    const withImage = createModelSource({ provider: 'openai', modelId: 'x2', metadata: { ...md, input: ['text', 'image'] } });
    expect(textOnly.model.input).toEqual(['text']);
    expect(withImage.model.input).toEqual(['text', 'image']);
  });
});

describe('resolveModelSourceFromEnv', () => {
  it('缺 LLM_PROVIDER/LLM_MODEL → null', () => {
    expect(resolveModelSourceFromEnv({})).toBeNull();
    expect(resolveModelSourceFromEnv({ LLM_PROVIDER: 'openai' })).toBeNull();
  });

  it('齐全 + base URL 在白名单 → 构造并覆盖 baseUrl', () => {
    const src = resolveModelSourceFromEnv({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-4o', LLM_BASE_URL: 'https://env-llm/v1', LLM_API_KEY: 'k', LLM_ALLOWED_BASE_URLS: 'https://env-llm' });
    expect(src).not.toBeNull();
    expect(src!.model.baseUrl).toBe('https://env-llm/v1');
  });

  it('三档均可 .env 配:tier → LLM_MODEL_{QUALITY|BALANCED|CHEAP}(§36 分档)', () => {
    const env = {
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'default-model',
      LLM_MODEL_QUALITY: 'reasoning-model',
      LLM_MODEL_BALANCED: 'mid-model',
      LLM_MODEL_CHEAP: 'cheap-model',
      LLM_TEMPLATE_MODEL: 'gpt-4o',
    } as NodeJS.ProcessEnv;
    expect(resolveModelSourceFromEnv(env, 'quality')!.model.id).toBe('reasoning-model');
    expect(resolveModelSourceFromEnv(env, 'balanced')!.model.id).toBe('mid-model');
    expect(resolveModelSourceFromEnv(env, 'cheap')!.model.id).toBe('cheap-model');
    expect(resolveModelSourceFromEnv(env)!.model.id).toBe('default-model');
  });

  it('tier 专属模型未设 → 回退 LLM_MODEL', () => {
    const env = { LLM_PROVIDER: 'openai', LLM_MODEL: 'only-model', LLM_TEMPLATE_MODEL: 'gpt-4o' } as NodeJS.ProcessEnv;
    expect(resolveModelSourceFromEnv(env, 'quality')!.model.id).toBe('only-model');
    expect(resolveModelSourceFromEnv(env, 'cheap')!.model.id).toBe('only-model');
  });
});

describe('assertModelEndpointAllowed(§防盗#1:ZDR 端点白名单,fail-closed)', () => {
  it('自定义 base URL 未配白名单 → 抛错(拒绝发往未审端点)', () => {
    expect(() => resolveModelSourceFromEnv({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-4o', LLM_BASE_URL: 'https://evil/v1' })).toThrow(ModelEndpointNotAllowedError);
  });
  it('自定义 base URL 不匹配白名单 → 抛错', () => {
    expect(() => assertModelEndpointAllowed({ provider: 'openai', baseUrl: 'https://evil/v1' }, { LLM_ALLOWED_BASE_URLS: 'https://my-cpa.zdr' })).toThrow(/未在 LLM_ALLOWED_BASE_URLS/);
  });
  it('base URL 前缀匹配白名单 → 通过', () => {
    expect(() => assertModelEndpointAllowed({ provider: 'openai', baseUrl: 'https://my-cpa.zdr/v1/chat' }, { LLM_ALLOWED_BASE_URLS: 'https://my-cpa.zdr,https://api.openai.com' })).not.toThrow();
  });
  it('provider 白名单:不在内 → 抛错;在内 → 通过', () => {
    expect(() => assertModelEndpointAllowed({ provider: 'sketchy' }, { LLM_ALLOWED_PROVIDERS: 'openai,anthropic' })).toThrow(/不在 LLM_ALLOWED_PROVIDERS/);
    expect(() => assertModelEndpointAllowed({ provider: 'openai' }, { LLM_ALLOWED_PROVIDERS: 'openai,anthropic' })).not.toThrow();
  });
  it('无自定义 base URL + 无白名单 → 允许(用官方默认端点)', () => {
    expect(() => assertModelEndpointAllowed({ provider: 'openai' }, {})).not.toThrow();
  });
});

describe('模型身份选择器(0046 models 注册表)', () => {
  const ENV = {
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'env-default',
    LLM_MODEL_CHEAP: 'env-cheap',
    LLM_TEMPLATE_MODEL: 'gpt-4o',
    LLM_BASE_URL: 'https://gw.zdr/v1',
    LLM_API_KEY: 'k',
    LLM_ALLOWED_BASE_URLS: 'https://gw.zdr',
  } as NodeJS.ProcessEnv;

  it('传身份 → provider/model 取注册表,**baseUrl/apiKey 仍取 env**(密钥不进库)', () => {
    const s = resolveModelSourceFromEnv(ENV, { provider: 'openai', modelId: 'registry-model', templateModelId: 'gpt-4o' })!;
    expect(s.model.id).toBe('registry-model');
    expect(s.config?.baseUrl).toBe('https://gw.zdr/v1');
    expect(s.config?.apiKey).toBe('k');
    expect(s.config?.templateModelId).toBe('gpt-4o');
  });

  it('身份不带 templateModelId → **不继承 env 的**(注册表说了算,否则会串到别的模型的适配器)', () => {
    // Catalog models need no template and must not pick up the env one.
    const s = resolveModelSourceFromEnv(ENV, { provider: 'openai', modelId: 'gpt-4o' })!;
    expect(s.config?.templateModelId).toBeUndefined();
    // A non-catalog model without a template throws instead of silently using the env template.
    expect(() => resolveModelSourceFromEnv(ENV, { provider: 'openai', modelId: 'registry-only' })).toThrow(/templateModelId/);
  });

  it('身份的 provider 也过端点白名单(§防盗#1 不因来自 DB 而放行)', () => {
    expect(() =>
      resolveModelSourceFromEnv({ ...ENV, LLM_ALLOWED_PROVIDERS: 'anthropic' }, { provider: 'openai', modelId: 'x' }),
    ).toThrow(ModelEndpointNotAllowedError);
  });

  it('档位串仍走 env 路径(迁移期零行为变化)', () => {
    expect(resolveModelSourceFromEnv(ENV, 'cheap')!.model.id).toBe('env-cheap');
    expect(resolveModelSourceFromEnv(ENV)!.model.id).toBe('env-default');
  });
});
