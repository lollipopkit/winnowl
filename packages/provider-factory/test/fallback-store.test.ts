import { describe, expect, it, vi } from 'vitest';
import { createFallbackCredentialStore, type ProviderCredentialStore } from '../src/index.js';

const appCreds = { appId: '1', privateKeyPem: 'pem' };

function store(over: Partial<ProviderCredentialStore>): ProviderCredentialStore {
  return {
    githubAppCredentials: async () => null,
    token: async () => null,
    ...over,
  };
}

describe('createFallbackCredentialStore(§42 KMS→env 优雅降级)', () => {
  it('primary 命中 → 用 primary,不碰 fallback', async () => {
    const fallback = store({ githubAppCredentials: vi.fn(async () => ({ appId: 'env', privateKeyPem: 'x' })) });
    const s = createFallbackCredentialStore(store({ githubAppCredentials: async () => appCreds }), fallback);
    expect(await s.githubAppCredentials('h')).toEqual(appCreds);
    expect(fallback.githubAppCredentials).not.toHaveBeenCalled();
  });

  it('primary 未命中(null)→ 回退 fallback', async () => {
    const s = createFallbackCredentialStore(
      store({ githubAppCredentials: async () => null }),
      store({ githubAppCredentials: async () => appCreds }),
    );
    expect(await s.githubAppCredentials('h')).toEqual(appCreds);
  });

  it('primary 抛错(Vault 故障)→ 回退 fallback + onError 回调', async () => {
    const onError = vi.fn();
    const s = createFallbackCredentialStore(
      store({ githubAppCredentials: async () => { throw new Error('vault down'); } }),
      store({ githubAppCredentials: async () => appCreds }),
      onError,
    );
    expect(await s.githubAppCredentials('h')).toEqual(appCreds);
    expect(onError).toHaveBeenCalledWith('github-app', 'h', expect.any(Error));
  });

  it('token 同样优先 primary、失败回退', async () => {
    const s = createFallbackCredentialStore(
      store({ token: async () => { throw new Error('boom'); } }),
      store({ token: async () => 'env-token' }),
    );
    expect(await s.token('h')).toBe('env-token');
  });
});
