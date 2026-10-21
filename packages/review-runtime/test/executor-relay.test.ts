import { describe, expect, it } from 'vitest';
import { defaultConfig } from '@reviewbot/config';
import { createModelSource } from '@reviewbot/agent-pi';
import { relayExecutorSpec } from '../src/executor-relay.js';
import type { ReviewExecutorSpec } from '../src/executor-spec.js';

const RELAY = { url: 'http://100.64.0.1:8793/', token: 'job-token-0123456789' };

const spec = (): ReviewExecutorSpec => ({
  revisionSha: 'deadbeef',
  changedFiles: [],
  headChangedLines: {},
  model: { provider: 'openai', modelId: 'gpt-4o', baseUrl: 'https://gw.example/v1', apiKey: 'sk-main-secret-1' },
  fallbackModels: [{ provider: 'openai', modelId: 'gpt-4o-mini', baseUrl: 'https://gw.example/v1', apiKey: 'sk-main-secret-1' }],
  stageModels: [
    { stage: 'verify', strategy: 'round-robin', models: [{ provider: 'anthropic', modelId: 'claude-sonnet-4-5', apiKey: 'sk-ant-byok-secret' }] },
  ],
  dedup: { kind: 'embedding', baseUrl: 'https://gw.example/v1', apiKey: 'sk-main-secret-1', model: 'text-embedding-3-small' },
  plugins: {
    config: defaultConfig().plugins,
    credentials: { exa: 'exa-tenant-secret' },
    platformEnv: { EXA_API_KEY: 'exa-platform-secret', CONTEXT7_API_KEY: 'ctx7-platform-secret' },
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

describe('relayExecutorSpec: no key enters the sandbox', () => {
  it('moves every key into relay upstreams and points the sandbox at the relay', () => {
    const { spec: out, upstreams } = relayExecutorSpec(spec(), RELAY);
    const text = JSON.stringify(out);
    for (const secret of ['sk-main-secret-1', 'sk-ant-byok-secret', 'exa-tenant-secret', 'exa-platform-secret', 'ctx7-platform-secret', 'sk-lf-secret-123', 'pk-lf-public']) {
      expect(text).not.toContain(secret);
    }
    expect(out.model.relay).toEqual({ url: 'http://100.64.0.1:8793/r/m0', token: RELAY.token });
    expect(out.model.baseUrl).toBe('https://gw.example/v1');
    expect(out.fallbackModels?.[0]?.relay?.url).toBe('http://100.64.0.1:8793/r/m1');
    expect(out.stageModels?.[0]?.models[0]?.relay?.url).toBe('http://100.64.0.1:8793/r/m2');
    expect(out.dedup).toMatchObject({ baseUrl: 'http://100.64.0.1:8793/r/embed', apiKey: RELAY.token });
    // The tenant's Exa key wins over the platform's; context7 uses the platform key.
    expect(out.plugins?.relays).toEqual({
      exa: { url: 'http://100.64.0.1:8793/r/p-exa', token: RELAY.token, keySource: 'tenant' },
      context7: { url: 'http://100.64.0.1:8793/r/p-context7', token: RELAY.token, keySource: 'platform' },
    });
    expect(out.telemetry).toEqual({ traceCarrier: { traceparent: '00-abc-def-01' } });
    expect(upstreams).toEqual({
      m0: { baseUrl: 'https://gw.example/v1', key: 'sk-main-secret-1' },
      m1: { baseUrl: 'https://gw.example/v1', key: 'sk-main-secret-1' },
      // No baseUrl configured: the catalog's endpoint is the upstream.
      m2: { baseUrl: 'https://api.anthropic.com', key: 'sk-ant-byok-secret' },
      embed: { baseUrl: 'https://gw.example/v1', key: 'sk-main-secret-1' },
      'p-exa': { baseUrl: 'https://api.exa.ai', key: 'exa-tenant-secret' },
      'p-context7': { baseUrl: 'https://context7.com/api/v2', key: 'ctx7-platform-secret' },
    });
  });

  it('a relayed model sends to the relay with the token, keeping the real endpoint’s compat', () => {
    const { spec: out } = relayExecutorSpec(spec(), RELAY);
    const relayed = createModelSource(out.model);
    expect(relayed.model.baseUrl).toBe('http://100.64.0.1:8793/r/m0');
    const direct = createModelSource(spec().model);
    expect(relayed.model.compat).toEqual(direct.model.compat);
  });

  it('refuses a spec where a key survives in some other field', () => {
    const leaky = { ...spec(), changeSummary: 'debug: sk-main-secret-1' };
    expect(() => relayExecutorSpec(leaky, RELAY)).toThrow(/key would still enter/);
  });
});
