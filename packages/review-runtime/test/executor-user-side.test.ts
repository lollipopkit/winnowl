import { describe, expect, it } from 'vitest';
import { defaultConfig } from '@reviewbot/config';
import { bindLocalCredentials, executorErrorReport, LocalCredentialsError, unkeyedExecutorSpec } from '../src/executor-user-side.js';
import type { ReviewExecutorSpec } from '../src/executor-spec.js';

const spec = (): ReviewExecutorSpec => ({
  revisionSha: 'deadbeef',
  revisionId: 'rev-1',
  changedFiles: [],
  headChangedLines: {},
  model: { provider: 'openai', modelId: 'gpt-6-luna', baseUrl: 'https://gw.example/v1', apiKey: 'sk-platform-secret', requestTimeoutMs: 1000 },
  fallbackModels: [{ provider: 'openai', modelId: 'deepseek-v4.1-flash', baseUrl: 'https://gw.example/v1', apiKey: 'sk-platform-secret' }],
  stageModels: [
    {
      stage: 'verify',
      strategy: 'round-robin',
      models: [{ provider: 'openai', modelId: 'claude-haiku-5-5', relay: { url: 'http://relay/r/m0', token: 'relay-token-123' } }],
    },
  ],
  dedup: { kind: 'embedding', baseUrl: 'https://gw.example/v1', apiKey: 'sk-platform-secret', model: 'text-embedding-3-small' },
  plugins: {
    config: defaultConfig().plugins,
    credentials: { exa: 'exa-tenant-secret' },
    platformEnv: { EXA_API_KEY: 'exa-platform-secret' },
  },
  telemetry: {
    langfuseEndpoint: 'https://lf.example/api/public/otel',
    langfusePublicKey: 'pk-lf-public',
    langfuseSecretKey: 'sk-lf-secret-123',
    traceCarrier: { traceparent: '00-abc-def-01' },
  },
  budget: { maxTurns: 10, maxToolCalls: 20 },
  promptDigests: [],
});

describe('unkeyedExecutorSpec: what leaves for the user-side executor', () => {
  it('keeps model identities only, no key, endpoint, relay token or Langfuse credentials', () => {
    const out = unkeyedExecutorSpec(spec());
    const text = JSON.stringify(out);
    for (const secret of ['sk-platform-secret', 'relay-token-123', 'exa-tenant-secret', 'exa-platform-secret', 'sk-lf-secret-123', 'pk-lf-public', 'gw.example']) {
      expect(text).not.toContain(secret);
    }
    expect(out.model).toEqual({ provider: 'openai', modelId: 'gpt-6-luna', requestTimeoutMs: 1000 });
    expect(out.stageModels?.[0]?.models[0]).toEqual({ provider: 'openai', modelId: 'claude-haiku-5-5' });
    expect(out.dedup).toEqual({ kind: 'llm' });
    expect(out.telemetry).toEqual({ traceCarrier: { traceparent: '00-abc-def-01' } });
  });
});

describe('bindLocalCredentials: the user key, on the executor side', () => {
  it('attaches the user endpoint and key to every model the server chose', () => {
    const out = bindLocalCredentials(unkeyedExecutorSpec(spec()), { LLM_API_KEY: 'sk-user', LLM_BASE_URL: 'https://user.example/v1', EXA_API_KEY: 'exa-user' });
    expect(out.model).toMatchObject({ modelId: 'gpt-6-luna', apiKey: 'sk-user', baseUrl: 'https://user.example/v1' });
    expect(out.fallbackModels?.[0]).toMatchObject({ modelId: 'deepseek-v4.1-flash', apiKey: 'sk-user' });
    expect(out.stageModels?.[0]?.models[0]).toMatchObject({ modelId: 'claude-haiku-5-5', apiKey: 'sk-user' });
    expect(out.plugins?.platformEnv).toEqual({ EXA_API_KEY: 'exa-user' });
  });

  it('LLM_MODEL replaces every stage with one model of the user', () => {
    const out = bindLocalCredentials(unkeyedExecutorSpec(spec()), { LLM_API_KEY: 'sk-user', LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-haiku-5-5' });
    expect(out.model).toEqual({ provider: 'anthropic', modelId: 'claude-haiku-5-5', apiKey: 'sk-user', requestTimeoutMs: 1000 });
    expect(out.fallbackModels).toBeUndefined();
    expect(out.stageModels).toBeUndefined();
  });

  it('empty inputs from the action count as unset; no key is a named error', () => {
    const out = bindLocalCredentials(unkeyedExecutorSpec(spec()), { LLM_API_KEY: 'sk-user', LLM_BASE_URL: '', LLM_MODEL: ' ' });
    expect(out.model.baseUrl).toBeUndefined();
    expect(out.model.modelId).toBe('gpt-6-luna');
    let err: unknown;
    try {
      bindLocalCredentials(spec(), { LLM_API_KEY: '' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LocalCredentialsError);
    expect(executorErrorReport(err).name).toBe('LocalCredentialsError');
  });
});
