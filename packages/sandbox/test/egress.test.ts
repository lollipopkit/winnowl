import { describe, expect, it } from 'vitest';
import { allowedHostsFor, buildEgressProxyConfig, PERMANENT_BLOCK_CIDRS, REGISTRY_ECOSYSTEMS } from '../src/index.js';

describe('Egress Proxy 配置', () => {
  it('none/full 不经代理', () => {
    expect(buildEgressProxyConfig({ mode: 'none' }).requiresProxy).toBe(false);
    expect(buildEgressProxyConfig({ mode: 'full', adminApproved: true }).requiresProxy).toBe(false);
  });

  it('package-registry-only:展开生态 registry 主机', () => {
    const hosts = allowedHostsFor({ mode: 'package-registry-only', ecosystems: ['npm', 'pypi'] });
    expect(hosts).toContain('registry.npmjs.org');
    expect(hosts).toContain('pypi.org');
    expect(hosts).not.toContain('crates.io');
  });

  it('registry-proxy (every ecosystem) admits GitHub-served dependencies, once each, and nothing else', () => {
    const hosts = allowedHostsFor({ mode: 'package-registry-only', ecosystems: [...REGISTRY_ECOSYSTEMS] });
    expect(hosts).toEqual(expect.arrayContaining(['github.com', 'codeload.github.com', 'release-assets.githubusercontent.com']));
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(hosts).not.toContain('raw.githubusercontent.com');
    expect(hosts.some((h) => /openai|anthropic|api\./.test(h))).toBe(false);
  });

  it('allowlist:仅放行显式主机,默认拒绝,永久阻断内网/metadata', () => {
    const cfg = buildEgressProxyConfig({ mode: 'allowlist', hosts: ['api.internal.example.com'] });
    expect(cfg.requiresProxy).toBe(true);
    expect(cfg.allowedHosts).toEqual(['api.internal.example.com']);
    expect(cfg.squidConf).toContain('dstdomain api.internal.example.com');
    expect(cfg.squidConf).toContain('http_access allow allow_host_0');
    // Deny by default.
    expect(cfg.squidConf.trimEnd().endsWith('http_access deny all')).toBe(true);
    // Block metadata/private ranges, deny before allow.
    expect(cfg.squidConf).toContain('169.254.0.0/16');
    const denyIdx = cfg.squidConf.indexOf('http_access deny block_cidr_0');
    const allowIdx = cfg.squidConf.indexOf('http_access allow allow_host_0');
    expect(denyIdx).toBeGreaterThan(0);
    expect(denyIdx).toBeLessThan(allowIdx); // block takes effect before allow
  });

  it('a private relay endpoint: that address and port only (HTTP or tunnel), the rest of CGNAT still blocked', () => {
    const cfg = buildEgressProxyConfig(
      { mode: 'allowlist', hosts: ['registry.npmjs.org'] },
      { privateHttpEndpoints: [{ ip: '100.64.0.1', port: 8793 }] },
    );
    const conf = cfg.squidConf;
    expect(conf).toContain('acl relay_dst_0 dst 100.64.0.1/32');
    expect(conf).toContain('acl relay_port_0 port 8793');
    expect(conf).toContain('http_access allow relay_dst_0 relay_port_0');
    // Before the CONNECT port restriction: undici's ProxyAgent tunnels http targets.
    expect(conf.indexOf('http_access allow relay_dst_0')).toBeLessThan(conf.indexOf('http_access deny CONNECT !SSL_ports'));
    expect(conf).toMatch(/acl block_cidr_\d+ dst 100\.64\.0\.0\/10/);
    expect(conf.indexOf('http_access allow relay_dst_0')).toBeLessThan(conf.indexOf('http_access deny block_cidr_0'));
    expect(() => buildEgressProxyConfig({ mode: 'allowlist', hosts: [] }, { privateHttpEndpoints: [{ ip: 'relay.example', port: 1 }] })).toThrow();
  });

  it('永久阻断 CIDR 全部进入配置', () => {
    const cfg = buildEgressProxyConfig({ mode: 'allowlist', hosts: ['x.com'] });
    for (const cidr of PERMANENT_BLOCK_CIDRS) expect(cfg.squidConf).toContain(cidr);
  });

  it('DNS rebinding 防御:内网/metadata 按 dst(解析后 IP)阻断且先于 allow —— 恶意主机 DNS 重绑到内网仍被拒', () => {
    // evil.example.com is allowed by name, but squid `dst` matches the resolved IP, so DNS rebinding to
    // a private address hits block_cidr (before allow_host) and is denied.
    const cfg = buildEgressProxyConfig({ mode: 'allowlist', hosts: ['evil.example.com'] });
    // `dst` (resolved IP), not `dstdomain`, is what defeats DNS rebinding.
    expect(cfg.squidConf).toMatch(/acl block_cidr_\d+ dst 169\.254\.0\.0\/16/);
    expect(cfg.squidConf).toMatch(/acl block_cidr_\d+ dst 127\.0\.0\.0\/8/);
    // Every private-range deny precedes the host allow (top-down evaluation).
    const allowIdx = cfg.squidConf.indexOf('http_access allow allow_host_0');
    const denies = [...cfg.squidConf.matchAll(/http_access deny block_cidr_\d+/g)];
    expect(denies.length).toBe(PERMANENT_BLOCK_CIDRS.length);
    for (const d of denies) expect(d.index!).toBeLessThan(allowIdx);
  });

  it('HTTPS:仅允许 CONNECT 到 443,且该限制先于 host allow', () => {
    const cfg = buildEgressProxyConfig({ mode: 'allowlist', hosts: ['api.exa.ai'] });
    expect(cfg.squidConf).toContain('acl SSL_ports port 443');
    expect(cfg.squidConf).toContain('acl CONNECT method CONNECT');
    expect(cfg.squidConf).toContain('http_access deny CONNECT !SSL_ports');
    const connIdx = cfg.squidConf.indexOf('http_access deny CONNECT !SSL_ports');
    const allowIdx = cfg.squidConf.indexOf('http_access allow allow_host_0');
    expect(connIdx).toBeGreaterThan(0);
    expect(connIdx).toBeLessThan(allowIdx); // CONNECT port restriction before host allow
  });

  it('uses explicitly allowlisted CONNECT ports instead of silently restricting them to 443', () => {
    const cfg = buildEgressProxyConfig({
      mode: 'allowlist',
      hosts: ['gateway.example'],
      ports: [443, 8443],
    });
    expect(cfg.squidConf).toContain('acl SSL_ports port 443 8443');
  });
});
