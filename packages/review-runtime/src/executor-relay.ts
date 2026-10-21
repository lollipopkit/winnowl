import { upstreamBaseUrl, type ModelSourceConfig } from '@reviewbot/agent-pi';
import { PLUGIN_UPSTREAMS, resolvePluginKeys, type PluginRelay, type RelayedPlugin } from '@reviewbot/plugins';
import type { ReviewExecutorSpec } from './executor-spec.js';

/** Where the relay forwards one slot, with the key it adds. Stays on the control plane. */
export interface RelayUpstream {
  baseUrl: string;
  key: string;
}

export interface RelayedExecutorSpec {
  /** What the sandbox gets: endpoints point at the relay, keys are the job's relay token. */
  spec: ReviewExecutorSpec;
  /** slot → upstream, registered with the relay for this job. */
  upstreams: Record<string, RelayUpstream>;
}

/**
 * Takes every key out of an executor spec (sandbox hosts hold none): each keyed endpoint gets a relay
 * slot that the sandbox calls with the job token. Langfuse credentials are dropped; spans go through
 * the control plane. Throws if any key would still be in the result, so a new spec field cannot leak one.
 */
export function relayExecutorSpec(spec: ReviewExecutorSpec, relay: { url: string; token: string }): RelayedExecutorSpec {
  const upstreams: Record<string, RelayUpstream> = {};
  const slotUrl = (slot: string): string => `${relay.url.replace(/\/+$/, '')}/r/${slot}`;
  let models = 0;
  const viaRelay = (config: ModelSourceConfig): ModelSourceConfig => {
    if (!config.apiKey) return config;
    const slot = `m${models++}`;
    upstreams[slot] = { baseUrl: upstreamBaseUrl(config), key: config.apiKey };
    const { apiKey: _key, ...rest } = config;
    return { ...rest, relay: { url: slotUrl(slot), token: relay.token } };
  };

  const out: ReviewExecutorSpec = { ...spec, model: viaRelay(spec.model) };
  if (spec.fallbackModels) out.fallbackModels = spec.fallbackModels.map(viaRelay);
  if (spec.stageModels) out.stageModels = spec.stageModels.map((s) => ({ ...s, models: s.models.map(viaRelay) }));
  if (spec.dedup?.kind === 'embedding') {
    upstreams.embed = { baseUrl: spec.dedup.baseUrl, key: spec.dedup.apiKey };
    out.dedup = { ...spec.dedup, baseUrl: slotUrl('embed'), apiKey: relay.token };
  }
  if (spec.plugins) {
    const relays: Partial<Record<RelayedPlugin, PluginRelay>> = {};
    const keys = resolvePluginKeys(spec.plugins.credentials, spec.plugins.platformEnv ?? {});
    for (const name of Object.keys(keys) as RelayedPlugin[]) {
      const { key, keySource } = keys[name]!;
      upstreams[`p-${name}`] = { baseUrl: PLUGIN_UPSTREAMS[name], key };
      relays[name] = { url: slotUrl(`p-${name}`), token: relay.token, keySource };
    }
    out.plugins = { config: spec.plugins.config, ...(Object.keys(relays).length > 0 ? { relays } : {}) };
  }
  if (spec.telemetry) {
    const { langfuseEndpoint: _e, langfusePublicKey: _p, langfuseSecretKey: _s, ...rest } = spec.telemetry;
    out.telemetry = rest;
  }

  const text = JSON.stringify(out);
  const secrets = [
    ...Object.values(upstreams).map((u) => u.key),
    ...Object.values(spec.plugins?.credentials ?? {}),
    ...Object.values(spec.plugins?.platformEnv ?? {}),
    spec.telemetry?.langfuseSecretKey,
  ].filter((s): s is string => typeof s === 'string' && s.length >= 8);
  if (secrets.some((s) => text.includes(s))) {
    throw new Error('relayExecutorSpec: a key would still enter the sandbox spec');
  }
  return { spec: out, upstreams };
}
