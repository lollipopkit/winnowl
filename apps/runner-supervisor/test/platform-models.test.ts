import { describe, expect, it } from 'vitest';
import type { Db } from '@reviewbot/db';
import type { RegisteredModel } from '@reviewbot/entitlement';
import { createPlatformModels } from '../src/platform-models.js';

const env = { LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-6-luna', LLM_BASE_URL: 'https://gateway.example/v1', LLM_API_KEY: 'k', LLM_ALLOWED_BASE_URLS: 'https://gateway.example/v1' };
const registered = (modelId: string, sort: number, extra: Partial<RegisteredModel> = {}): RegisteredModel => ({
  id: modelId,
  provider: 'openai',
  modelId,
  active: true,
  sort,
  ...extra,
});

describe('platform model chain for the agents outside review', () => {
  it('is the env model alone until the model table has more', async () => {
    const models = createPlatformModels({} as Db, env, async () => []);
    await models.refresh();
    const src = models.source();
    expect(src?.model.id).toBe('gpt-6-luna');
  });

  it('keeps the env model first; the rest of the table sits behind it', async () => {
    const models = createPlatformModels({} as Db, env, async () => [
      registered('gpt-6-luna', 10),
      registered('deepseek-v4.1-flash', 20, {
        metadata: { name: 'DeepSeek', contextWindow: 1_048_576, maxTokens: 943_718, reasoning: true, input: ['text'], cost: { input: 0.2, output: 0.6 } },
      }),
    ]);
    await models.refresh();
    const src = models.source();
    expect(src?.model.id).toBe('gpt-6-luna');
    // The fallback lives inside streamFn; callers still see the primary model.
    expect(src?.config?.modelId).toBe('gpt-6-luna');
  });
});
