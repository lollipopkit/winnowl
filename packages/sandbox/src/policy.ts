import type { NetworkPolicy, SandboxSpec } from './types.js';

/**
 * The `sandbox` section of `.winnowl.yaml`, typed structurally to avoid a sandbox -> config
 * dependency; `EffectiveRepositoryConfig['sandbox']` is assignable to it.
 */
export interface RepoSandboxConfig {
  network?: {
    /** Unset: the platform's policy stands (the repository can only tighten it). */
    mode?: NetworkPolicy['mode'] | undefined;
    ecosystems?: readonly string[];
    hosts?: readonly string[];
    ports?: readonly number[];
  };
  resources?: {
    cpu?: number | undefined;
    memory_mb?: number | undefined;
    disk_mb?: number | undefined;
    timeout_seconds?: number | undefined;
  };
}

/** Strictness order (smaller = stricter); same order as config merge's LATTICE_FIELDS. */
const NETWORK_RANK: Record<NetworkPolicy['mode'], number> = {
  none: 0,
  'package-registry-only': 1,
  allowlist: 2,
  full: 3,
};

/** Missing fields mean empty sets, never an implicit allow. */
function policyFromRepo(cfg: NonNullable<RepoSandboxConfig['network']>): NetworkPolicy | undefined {
  switch (cfg.mode) {
    case 'none':
      return { mode: 'none' };
    case 'package-registry-only':
      return { mode: 'package-registry-only', ecosystems: [...(cfg.ecosystems ?? [])] };
    case 'allowlist':
      return { mode: 'allowlist', hosts: [...(cfg.hosts ?? [])], ...(cfg.ports?.length ? { ports: [...cfg.ports] } : {}) };
    case 'full':
      // full needs admin approval; a repository declaring it is not approval, so the baseline decides.
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Applies the repository's `sandbox` config to the platform baseline, only ever tightening it:
 * stricter network (repo `full` is ignored), min of cpu/memory/disk, min of timeout and maxLifetimeSeconds.
 *
 * Only for sandboxes running repository code (fix validation). Not for the review-executor
 * sandbox, or `network: none` in a repo would cut review off from the LLM gateway.
 */
export function applyRepoSandboxPolicy(baseline: SandboxSpec, cfg?: RepoSandboxConfig): SandboxSpec {
  if (!cfg) return baseline;
  const spec: SandboxSpec = { ...baseline };

  const repoNetwork = cfg.network ? policyFromRepo(cfg.network) : undefined;
  if (repoNetwork && NETWORK_RANK[repoNetwork.mode] < NETWORK_RANK[baseline.network.mode]) {
    spec.network = repoNetwork;
  }

  const r = cfg.resources;
  if (r) {
    spec.resources = {
      ...baseline.resources,
      ...(typeof r.cpu === 'number' ? { cpus: Math.min(baseline.resources.cpus, r.cpu) } : {}),
      ...(typeof r.memory_mb === 'number' ? { memoryMb: Math.min(baseline.resources.memoryMb, r.memory_mb) } : {}),
      ...(typeof r.disk_mb === 'number' ? { diskMb: Math.min(baseline.resources.diskMb, r.disk_mb) } : {}),
    };
    if (typeof r.timeout_seconds === 'number') {
      spec.maxLifetimeSeconds =
        baseline.maxLifetimeSeconds === undefined
          ? r.timeout_seconds
          : Math.min(baseline.maxLifetimeSeconds, r.timeout_seconds);
    }
  }
  return spec;
}
