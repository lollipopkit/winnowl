import { describe, expect, it } from 'vitest';
import type { Db } from '@reviewbot/db';
import type { RegisteredModel } from '@reviewbot/entitlement';
import { createPlatformModels } from '../src/platform-models.js';
import { resolveGlobalLearningModels } from '../src/wiring/agents.js';

const env = {
  LLM_PROVIDER: 'openai',
  LLM_MODEL: 'gpt-6-luna',
  LLM_MODEL_QUALITY: 'gpt-6-sol',
  LLM_BASE_URL: 'https://gateway.example/v1',
  LLM_API_KEY: 'k',
  LLM_ALLOWED_BASE_URLS: 'https://gateway.example/v1',
};

function settingsDb(panel?: string): Db {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst: async () => (panel ? { value: panel } : undefined) }),
      }),
    }),
  } as unknown as Db;
}

const registered = (modelId: string): RegisteredModel => ({
  id: modelId,
  provider: 'openai',
  modelId,
  active: true,
  sort: 0,
  metadata: { name: modelId, contextWindow: 200_000, maxTokens: 32_000, reasoning: true, input: ['text'], cost: { input: 1, output: 2 } },
});

describe('global learning panel follows knowledge.global_panel', () => {
  const platformModels = createPlatformModels({} as Db, env, async () => []);

  it('tiers: one vote per tier, a tier without its own model uses the default one', async () => {
    const models = await resolveGlobalLearningModels(settingsDb(), platformModels, { env, loadRegistry: async () => [] });
    expect(models?.draftModel.model.id).toBe('gpt-6-luna');
    expect(models?.panelModels.map((p) => p.id)).toEqual(['quality:gpt-6-sol', 'balanced:gpt-6-luna', 'cheap:gpt-6-luna']);
  });

  it('registry: one vote per enabled model in the model table', async () => {
    const models = await resolveGlobalLearningModels(settingsDb('registry'), platformModels, {
      env,
      loadRegistry: async () => [registered('gpt-6-luna'), registered('deepseek-v4.1-flash')],
    });
    expect(models?.panelModels.map((p) => p.id)).toEqual(['gpt-6-luna', 'deepseek-v4.1-flash']);
  });

  it('nothing to run with: no default model, or an empty registry', async () => {
    const none = createPlatformModels({} as Db, {}, async () => []);
    expect(await resolveGlobalLearningModels(settingsDb(), none, { env: {} })).toBeNull();
    expect(await resolveGlobalLearningModels(settingsDb('registry'), platformModels, { env, loadRegistry: async () => [] })).toBeNull();
  });
});
