import type { NetworkPolicy } from './types.js';
import { PERMANENT_BLOCK_CIDRS } from './network.js';

/** Package registry hosts per ecosystem, allowed in package-registry-only mode. */
const REGISTRY_HOSTS: Record<string, string[]> = {
  npm: ['registry.npmjs.org', 'registry.yarnpkg.com'],
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  // static.rust-lang.org: the toolchain a repository pins in rust-toolchain.toml (rustup installs it).
  cargo: ['crates.io', 'static.crates.io', 'index.crates.io', 'static.rust-lang.org'],
  go: ['proxy.golang.org', 'sum.golang.org'],
  maven: ['repo1.maven.org', 'repo.maven.apache.org'],
  rubygems: ['rubygems.org'],
  // pub.dev metadata; storage.googleapis.com hosts the package archives.
  dart: ['pub.dev', 'pub.dartlang.org', 'storage.googleapis.com'],
  flutter: ['pub.dev', 'pub.dartlang.org', 'storage.googleapis.com'],
  /*
   * Git dependencies (pubspec `git:`, cargo `git =`, npm `github:`) and prebuilt binaries from release
   * assets come from GitHub. Same exposure as registries: uploads need a token the code brings itself;
   * the sandbox holds none of ours.
   */
  github: ['github.com', 'codeload.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'],
};

/** All ecosystems with known registries; what registry-proxy admits. */
export const REGISTRY_ECOSYSTEMS: readonly string[] = Object.keys(REGISTRY_HOSTS);

export interface EgressProxyConfig {
  squidConf: string;
  /** For observability/audit. */
  allowedHosts: string[];
  /** none/full need no proxy. */
  requiresProxy: boolean;
}

export function allowedHostsFor(policy: NetworkPolicy): string[] {
  if (policy.mode === 'allowlist') return [...policy.hosts];
  if (policy.mode === 'package-registry-only') {
    // dart and flutter share their hosts.
    return [...new Set(policy.ecosystems.flatMap((e) => REGISTRY_HOSTS[e] ?? []))];
  }
  return [];
}

/**
  * A private-address HTTP endpoint sandboxes may reach through the proxy (the model relay on the API
  * host). Allowed by exact IPv4 address and port only.
 */
export interface PrivateHttpEndpoint {
  ip: string;
  port: number;
}

/**
 * squid config for a network policy. none/full need no proxy; allowlist/package-registry-only allow
 * only the listed hosts, deny by default, always block private ranges/metadata, and log every decision.
 */
export function buildEgressProxyConfig(
  policy: NetworkPolicy,
  extra: { privateHttpEndpoints?: readonly PrivateHttpEndpoint[] } = {},
): EgressProxyConfig {
  if (policy.mode === 'none' || policy.mode === 'full') {
    return { squidConf: '', allowedHosts: [], requiresProxy: false };
  }
  const hosts = allowedHostsFor(policy);
  const ports = policy.mode === 'allowlist' && policy.ports?.length ? policy.ports : [443];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('egress allowlist ports must be integers between 1 and 65535');
  }
  const endpoints = extra.privateHttpEndpoints ?? [];
  for (const e of endpoints) {
    if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(e.ip) || e.ip.split('.').some((o) => Number(o) > 255)) {
      throw new Error(`private endpoint must be an IPv4 address: ${e.ip}`);
    }
    if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65_535) throw new Error(`bad port ${e.port}`);
  }
  const lines: string[] = [
    '# reviewbot egress proxy(§11.6)自动生成;默认拒绝,仅放行 allowlist。',
    'http_port 3128',
    'access_log stdio:/var/log/squid/access.log',
    'cache deny all',
    'dns_v4_first on',
    'acl CONNECT method CONNECT',
    // Configured private endpoints first, exactly one address and port each, plain HTTP or CONNECT
    // (undici's ProxyAgent tunnels http targets too); every other private range stays blocked below.
    ...endpoints.flatMap((e, i) => [
      `acl relay_dst_${i} dst ${e.ip}/32`,
      `acl relay_port_${i} port ${e.port}`,
      `http_access allow relay_dst_${i} relay_port_${i}`,
    ]),
    // CONNECT only to the configured ports (default 443).
    `acl SSL_ports port ${ports.join(' ')}`,
    'http_access deny CONNECT !SSL_ports',
    // Block private ranges / metadata before any allow, even if allowlisted by mistake.
    ...PERMANENT_BLOCK_CIDRS.map((c, i) => `acl block_cidr_${i} dst ${c}`),
    ...PERMANENT_BLOCK_CIDRS.map((_, i) => `http_access deny block_cidr_${i}`),
    // Exact domains only, no subdomain wildcards; applies to CONNECT and plain requests.
    ...hosts.map((h, i) => `acl allow_host_${i} dstdomain ${h}`),
    ...hosts.map((_, i) => `http_access allow allow_host_${i}`),
    // Deny everything else.
    'http_access deny all',
  ];
  return { squidConf: lines.join('\n') + '\n', allowedHosts: hosts, requiresProxy: true };
}
