import { describe, expect, it } from 'vitest';
import { dockerNetworkArgs, UnsupportedNetworkPolicyError } from '../src/index.js';

const NETS = { egress: 'winnowl_sandbox-egress', registry: 'winnowl_sandbox-registry' };

describe('dockerNetworkArgs(§11.6 网络策略 → docker 参数)', () => {
  it('none:内核层完全隔离', () => {
    expect(dockerNetworkArgs({ mode: 'none' })).toEqual(['--network', 'none']);
  });

  it('full:bridge(管理员批准)', () => {
    expect(dockerNetworkArgs({ mode: 'full', adminApproved: true })).toEqual(['--network', 'bridge']);
  });

  it('allowlist:注入 egress 网络 → 接入该内部网(唯一可达=squid)', () => {
    expect(dockerNetworkArgs({ mode: 'allowlist', hosts: ['api.exa.ai'] }, NETS)).toEqual([
      '--network',
      'winnowl_sandbox-egress',
    ]);
  });

  it('package-registry-only joins the registry network, never the egress one', () => {
    expect(dockerNetworkArgs({ mode: 'package-registry-only', ecosystems: ['npm'] }, NETS)).toEqual([
      '--network',
      'winnowl_sandbox-registry',
    ]);
    // Only an egress network configured: fail closed instead of reaching the LLM gateway's proxy.
    expect(() =>
      dockerNetworkArgs({ mode: 'package-registry-only', ecosystems: ['npm'] }, { egress: 'winnowl_sandbox-egress' }),
    ).toThrow(UnsupportedNetworkPolicyError);
  });

  it('allowlist 未注入 egress 网络:fail-closed 抛错(不静默放行到 bridge)', () => {
    expect(() => dockerNetworkArgs({ mode: 'allowlist', hosts: ['x.com'] })).toThrow(UnsupportedNetworkPolicyError);
    expect(() =>
      dockerNetworkArgs({ mode: 'allowlist', hosts: ['x.com'] }, { registry: 'winnowl_sandbox-registry' }),
    ).toThrow(UnsupportedNetworkPolicyError);
  });
});
