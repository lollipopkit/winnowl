import { describe, expect, it } from 'vitest';
import { egressGuardedFetch, EgressDeniedError, PLUGIN_EGRESS_HOSTS } from '../src/index.js';

describe('egressGuardedFetch(§11.6 应用层出网守卫)', () => {
  it('allowlist 主机放行(转发 base fetch)', async () => {
    const base = (async () => new Response('ok')) as typeof fetch;
    const f = egressGuardedFetch(['api.exa.ai'], base);
    expect(await (await f('https://api.exa.ai/search')).text()).toBe('ok');
  });

  it('非 allowlist / 内网 metadata 主机 fail-closed —— 不发出请求', async () => {
    let called = false;
    const base = (async () => {
      called = true;
      return new Response('x');
    }) as typeof fetch;
    const f = egressGuardedFetch(['api.exa.ai'], base);
    await expect(f('https://evil.example/x')).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(f('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(f('http://localhost:5432')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(called).toBe(false);
  });

  it('去端口比对(host:port);URL/Request 入参形式', async () => {
    const base = (async () => new Response('ok')) as typeof fetch;
    const f = egressGuardedFetch(['api.exa.ai'], base);
    expect((await f('https://api.exa.ai:443/x')).status).toBe(200);
    expect((await f(new URL('https://api.exa.ai/y'))).status).toBe(200);
    await expect(f(new Request('https://evil.example/z'))).rejects.toBeInstanceOf(EgressDeniedError);
  });

  it('PLUGIN_EGRESS_HOSTS 覆盖三插件主机(守卫默认放行集)', () => {
    expect(PLUGIN_EGRESS_HOSTS).toContain('api.exa.ai');
    expect(PLUGIN_EGRESS_HOSTS).toContain('context7.com');
    expect(PLUGIN_EGRESS_HOSTS).toContain('registry.npmjs.org');
  });
});
