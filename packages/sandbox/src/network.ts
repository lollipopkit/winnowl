import type { NetworkPolicy } from './types.js';

/** Always blocked, even in full mode. Only `none` is fully guaranteed by kernel isolation. */
export const PERMANENT_BLOCK_CIDRS: readonly string[] = [
  '169.254.0.0/16', // link-local + cloud metadata
  '127.0.0.0/8', // loopback
  '10.0.0.0/8', // RFC1918
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10', // CGNAT: the hosts' private network (tailscale)
  '::1/128',
  'fe80::/10',
  'fd00::/8',
];

export class UnsupportedNetworkPolicyError extends Error {
  constructor(mode: string) {
    super(`network mode ${mode} needs its internal proxy network, which this backend was not given`);
    this.name = 'UnsupportedNetworkPolicyError';
  }
}

/**
 * Internal docker networks the proxied policies attach to. Each is `internal` (no route out) and
 * holds exactly one way out, a squid with its own allowlist:
 * - `egress`: review / scanner sandboxes (`allowlist`) → egress-proxy (LLM gateway, plugin and
 *   scanner hosts);
 * - `registry`: validation sandboxes (`package-registry-only`) → registry-proxy (package
 *   registries only). Kept apart so code that installs and runs a repository's dependencies cannot
 *   reach the LLM gateway, and review sandboxes cannot reach registries.
 */
export interface SandboxNetworks {
  egress?: string;
  registry?: string;
}

/**
 * Docker network args for a policy: none -> `--network none` (default); full -> bridge (admin
 * approved); allowlist / package-registry-only -> the matching internal network, whose only way out
 * is its squid. A missing network fails closed (never bridge, never the other network).
 */
export function dockerNetworkArgs(policy: NetworkPolicy, networks: SandboxNetworks = {}): string[] {
  switch (policy.mode) {
    case 'none':
      return ['--network', 'none'];
    case 'full':
      return ['--network', 'bridge'];
    case 'allowlist':
      if (!networks.egress) throw new UnsupportedNetworkPolicyError(policy.mode);
      return ['--network', networks.egress];
    case 'package-registry-only':
      if (!networks.registry) throw new UnsupportedNetworkPolicyError(policy.mode);
      return ['--network', networks.registry];
  }
}
