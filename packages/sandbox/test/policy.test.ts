import { describe, expect, it } from 'vitest';
import { applyRepoSandboxPolicy, type SandboxSpec } from '../src/index.js';

const baseline: SandboxSpec = {
  image: 'polyglot-ci:latest',
  network: { mode: 'package-registry-only', ecosystems: ['npm'] },
  resources: { cpus: 1, memoryMb: 2048, pids: 1024, diskMb: 4096 },
  maxLifetimeSeconds: 1200,
};

describe('applyRepoSandboxPolicy(§37 sandbox 接线,只收紧不放宽)', () => {
  it('无配置 → 原样返回 baseline', () => {
    expect(applyRepoSandboxPolicy(baseline)).toEqual(baseline);
  });

  it('schema 默认值(4C/8G/20G/1800s)不得放宽 baseline', () => {
    const spec = applyRepoSandboxPolicy(baseline, {
      network: { mode: 'none' as const, ecosystems: [], hosts: [], ports: [] },
      resources: { cpu: 4, memory_mb: 8192, disk_mb: 20480, timeout_seconds: 1800 },
    });
    expect(spec.resources).toEqual(baseline.resources);
    expect(spec.maxLifetimeSeconds).toBe(1200);
  });

  it('resources 取 min(仓库可自我调小)', () => {
    const spec = applyRepoSandboxPolicy(baseline, {
      resources: { cpu: 1, memory_mb: 512, disk_mb: 1024, timeout_seconds: 300 },
    });
    expect(spec.resources).toEqual({ cpus: 1, memoryMb: 512, pids: 1024, diskMb: 1024 });
    expect(spec.maxLifetimeSeconds).toBe(300);
  });

  it('network 可收紧到 none(断网跑验证)', () => {
    const spec = applyRepoSandboxPolicy(baseline, { network: { mode: 'none' } });
    expect(spec.network).toEqual({ mode: 'none' });
  });

  it('network 不可放宽:仓库声明 full / allowlist 均不生效(baseline 更严者胜)', () => {
    expect(applyRepoSandboxPolicy(baseline, { network: { mode: 'full' } }).network).toEqual(baseline.network);
    expect(
      applyRepoSandboxPolicy(baseline, { network: { mode: 'allowlist', hosts: ['evil.example'] } }).network,
    ).toEqual(baseline.network);
  });

  it('baseline 更宽时仓库可收紧到 allowlist,并带上自己的 hosts', () => {
    const wide: SandboxSpec = { ...baseline, network: { mode: 'full', adminApproved: true } };
    const spec = applyRepoSandboxPolicy(wide, { network: { mode: 'allowlist', hosts: ['registry.npmjs.org'], ports: [443] } });
    expect(spec.network).toEqual({ mode: 'allowlist', hosts: ['registry.npmjs.org'], ports: [443] });
  });

  it('a repository config that leaves network and resources unset changes nothing', () => {
    const base = { image: 'i', network: { mode: 'package-registry-only' as const, ecosystems: ['npm'] }, resources: { cpus: 2, memoryMb: 4096, pids: 64, diskMb: 8192 } };
    expect(applyRepoSandboxPolicy(base, { network: { ecosystems: [], hosts: [], ports: [] }, resources: {} })).toEqual(base);
  });
});

