import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RestClient } from '@reviewbot/provider-http';
import { FakeProviderServer } from '@reviewbot/testkit';
import { GitHubAppAuth } from '../src/index.js';

// Throwaway 1024-bit key: faster, avoids timeouts under parallel load.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe('GitHubAppAuth', () => {
  it('用 App JWT 换取安装 token 并缓存', async () => {
    const server = new FakeProviderServer();
    cleanups.push(() => server.close());
    server.on('POST', '/app/installations/123/access_tokens', {
      status: 201,
      body: { token: 'ghs_installation', expires_at: '2999-01-01T00:00:00Z' },
    });
    const url = await server.listen();

    const auth = new GitHubAppAuth({
      appId: '42',
      privateKeyPem,
      installationId: '123',
      client: new RestClient({ baseUrl: url }),
      now: () => 1_800_000_000_000,
    });

    const t1 = await auth.installationToken();
    const t2 = await auth.installationToken();
    expect(t1).toBe('ghs_installation');
    expect(t2).toBe('ghs_installation');
    // Cached: only one token exchange
    expect(server.requests).toHaveLength(1);
    const authHeader = server.requests[0]?.headers['authorization'];
    expect(String(authHeader)).toMatch(/^Bearer .+\..+\..+$/);
  });

  it('appJwt 产出三段式 JWT', () => {
    const auth = new GitHubAppAuth({
      appId: '42',
      privateKeyPem,
      installationId: '123',
      client: new RestClient({ baseUrl: 'http://127.0.0.1:1' }),
      now: () => 1_800_000_000_000,
    });
    expect(auth.appJwt().split('.')).toHaveLength(3);
  });
});
