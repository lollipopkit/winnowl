import type { AgentTool } from '@reviewbot/agent-pi';
import type { EffectiveRepositoryConfig } from '@reviewbot/config';
import { buildExaTools, EXA_BASE_URL, EXA_TOOL_NAMES } from './exa.js';
import { buildContext7Tools, CONTEXT7_BASE_URL, CONTEXT7_TOOL_NAMES } from './context7.js';
import { buildPkgRegistryTools, PKG_REGISTRY_HOSTS, PKG_REGISTRY_TOOL_NAMES } from './pkg-registry.js';
import { egressGuardedFetch } from './egress-guard.js';

export type PluginsConfig = EffectiveRepositoryConfig['plugins'];

export type PluginName = keyof PluginsConfig;

/**
 * Supply-chain origin. `platform` and `vendor-official` need no pin; `community` must pin
 * `package@version` + sha512 or loading fails closed (guards against malicious later versions).
 */
export interface PluginManifestEntry {
  name: PluginName;
  publisher: 'platform' | 'vendor-official' | 'community';
  /** Upstream reference for provenance; not a code dependency. */
  upstream?: string;
  /** Required for community: package + exact version + npm sha512 integrity. */
  pinned?: { package: string; version: string; sha512: string };
}

export const PLUGIN_MANIFEST: readonly PluginManifestEntry[] = [
  { name: 'exa', publisher: 'platform', upstream: 'pi-exa(社区包,借鉴能力自实现,无代码依赖)' },
  { name: 'context7', publisher: 'platform', upstream: '@upstash/context7-pi(Upstash 官方扩展,借鉴能力自实现,无代码依赖)' },
  { name: 'registry', publisher: 'platform', upstream: '官方 registry 公开 API(npm/PyPI/crates.io/Go proxy),自实现' },
];

export function assertPluginSupplyChain(entry: PluginManifestEntry): void {
  if (entry.publisher !== 'community') return;
  const p = entry.pinned;
  if (!p || !p.package || !/^\d+\.\d+\.\d+$/.test(p.version) || !p.sha512.startsWith('sha512-')) {
    throw new Error(
      `plugin ${entry.name}: community 来源必须钉死 package + 精确 version + sha512 integrity(防供应链注入);缺失拒绝装载`,
    );
  }
}

export interface ResolvePluginsInput {
  plugins: PluginsConfig;
  /** Tenant credentials (already resolved); each present entry wins over the platform env key. */
  credentials?: Partial<Record<PluginName, string>>;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** Awaited before each tool call so the audit precedes the outbound request; its failure never blocks the tool. */
  onToolCall?: (event: PluginToolCallEvent) => void | Promise<void>;
  /**
   * Keyed plugins reached through the platform's model relay (review sandboxes hold no key): the
   * relay URL and token replace the endpoint and key; `keySource` says whose key the relay uses.
   * A plugin listed here ignores `credentials` / `env`.
   */
  relays?: Partial<Record<RelayedPlugin, PluginRelay>>;
}

/** Plugins whose calls carry a key, hence go through the relay in sandboxes. */
export type RelayedPlugin = 'exa' | 'context7';
export interface PluginRelay {
  url: string;
  token: string;
  keySource: PluginKeySource;
}

/**
 * The key each keyed plugin would use and whose it is: tenant credential (user > repo > org,
 * already resolved) over the platform's env key. The relay transform needs exactly this to hold
 * the keys on the control plane.
 */
export function resolvePluginKeys(
  credentials: Partial<Record<PluginName, string>> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<RelayedPlugin, { key: string; keySource: 'tenant' | 'platform' }>> {
  const out: Partial<Record<RelayedPlugin, { key: string; keySource: 'tenant' | 'platform' }>> = {};
  for (const name of ['exa', 'context7'] as const) {
    const tenantKey = credentials?.[name]?.trim();
    const platformKey = env[PLATFORM_KEY_ENV[name] ?? '']?.trim();
    if (tenantKey) out[name] = { key: tenantKey, keySource: 'tenant' };
    else if (platformKey) out[name] = { key: platformKey, keySource: 'platform' };
  }
  return out;
}

/** The upstream endpoint of a relayed plugin (what the relay forwards to). */
export const PLUGIN_UPSTREAMS: Record<RelayedPlugin, string> = { exa: EXA_BASE_URL, context7: CONTEXT7_BASE_URL };

/** `args` summarises scalar params (300 chars each); may contain repo content, so only tenant-scoped audit gets it. */
export interface PluginToolCallEvent {
  plugin: PluginName;
  tool: string;
  keySource: PluginKeySource;
  args?: Record<string, string>;
}

const ARG_MAX_CHARS = 300;

function summarizeArgs(params: unknown): Record<string, string> | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v).slice(0, ARG_MAX_CHARS);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Billing attribution: platform env key, tenant key, or keyless. */
export type PluginKeySource = 'platform' | 'tenant' | 'none';

/**
 * Platform cost per call in USD from list prices (exa search $7/1k at ≤10 results, contents $1/1k
 * pages). Only charged when keySource=platform.
 */
export const PLUGIN_TOOL_COST_USD: Readonly<Record<string, number>> = {
  'exa:web_search': 0.007,
  'exa:fetch_url': 0.001,
  'context7:resolve_library_id': 0,
  'context7:query_docs': 0,
  'registry:lookup_package': 0,
};

/** Unknown tools cost 0. */
export function pluginCallCostUsd(plugin: string, tool: string, keySource: PluginKeySource): number {
  if (keySource !== 'platform') return 0;
  return PLUGIN_TOOL_COST_USD[`${plugin}:${tool}`] ?? 0;
}

export interface ResolvedPlugins {
  tools: AgentTool[];
  active: PluginName[];
  skipped: { name: PluginName; reason: 'disabled' | 'missing-credentials' }[];
  /** Public source URLs returned so far (append-only); ecosystem knowledge must cite one of these. */
  sources: ReadonlySet<string>;
}

function instrument(
  plugin: PluginName,
  keySource: PluginKeySource,
  tools: AgentTool[],
  onToolCall: ResolvePluginsInput['onToolCall'],
): AgentTool[] {
  if (!onToolCall) return tools;
  return tools.map((t) => ({
    ...t,
    execute: async (id, params, signal, onUpdate) => {
      try {
        const args = summarizeArgs(params);
        await onToolCall({ plugin, tool: t.name, keySource, ...(args ? { args } : {}) });
      } catch {
        // Audit failure must not block the tool call.
      }
      return t.execute(id, params, signal, onUpdate);
    },
  }));
}

const PLATFORM_KEY_ENV: Partial<Record<PluginName, string>> = { exa: 'EXA_API_KEY', context7: 'CONTEXT7_API_KEY' };

/** Env subset with only platform plugin keys, shipped into sandboxes that lack the control-plane env. */
export function platformPluginEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.values(PLATFORM_KEY_ENV)) {
    const value = env[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

/** Plugins that require a key are skipped (not an error) when none is configured. */
export function resolvePluginTools(input: ResolvePluginsInput): ResolvedPlugins {
  const env = input.env ?? process.env;
  const tools: AgentTool[] = [];
  const active: PluginName[] = [];
  const skipped: ResolvedPlugins['skipped'] = [];
  // Every plugin fetch goes through the egress allowlist (fail-closed).
  const sources = new Set<string>();
  // The relay's host is allowed only when a plugin is routed through it.
  const relayHosts = Object.values(input.relays ?? {}).map((r) => new URL(r.url).host);
  const fetchOpt = {
    fetchFn: egressGuardedFetch([...PLUGIN_EGRESS_HOSTS, ...relayHosts], input.fetchFn ?? fetch),
    onSource: (url: string) => void sources.add(url),
  };

  const gate = (
    name: PluginName,
    enabled: boolean,
    keyRequired: boolean,
    build: (key: string | undefined, relayUrl?: string) => AgentTool[],
  ): void => {
    if (!enabled) {
      skipped.push({ name, reason: 'disabled' });
      return;
    }
    const relay = input.relays?.[name as RelayedPlugin];
    if (relay) {
      assertPluginSupplyChain(PLUGIN_MANIFEST.find((m) => m.name === name)!);
      tools.push(...instrument(name, relay.keySource, build(relay.token, relay.url), input.onToolCall));
      active.push(name);
      return;
    }
    const tenantKey = input.credentials?.[name]?.trim();
    const platformKey = env[PLATFORM_KEY_ENV[name] ?? '']?.trim();
    const apiKey = tenantKey || platformKey || undefined;
    if (keyRequired && !apiKey) {
      skipped.push({ name, reason: 'missing-credentials' });
      return;
    }
    const keySource: PluginKeySource = tenantKey ? 'tenant' : apiKey ? 'platform' : 'none';
    assertPluginSupplyChain(PLUGIN_MANIFEST.find((m) => m.name === name)!);
    tools.push(...instrument(name, keySource, build(apiKey), input.onToolCall));
    active.push(name);
  };

  gate('exa', input.plugins.exa.enabled, true, (key, relayUrl) =>
    buildExaTools({ apiKey: key!, ...(relayUrl ? { relayUrl } : {}), ...fetchOpt }),
  );
  // context7 works without a key at a lower rate limit.
  gate('context7', input.plugins.context7.enabled, false, (key, relayUrl) =>
    buildContext7Tools({ ...(key ? { apiKey: key } : {}), ...(relayUrl ? { relayUrl } : {}), ...fetchOpt }),
  );
  gate('registry', input.plugins.registry.enabled, false, () => buildPkgRegistryTools(fetchOpt));

  return { tools, active, skipped, sources };
}

export { EXA_TOOL_NAMES, CONTEXT7_TOOL_NAMES, PKG_REGISTRY_TOOL_NAMES };

/** Hosts plugins call; the deployment's egress proxy allowlist is built from this. */
export const PLUGIN_EGRESS_HOSTS: readonly string[] = [new URL(EXA_BASE_URL).host, new URL(CONTEXT7_BASE_URL).host, ...PKG_REGISTRY_HOSTS];
