import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LlmRelayClient, llmRelayFromEnv, relayAdminToken } from '../src/llm-relay.js';

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop()!.close(r));
});

async function fakeAdmin(status = 204) {
  const calls: { method: string; url: string; auth?: string; body?: Record<string, unknown> }[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      calls.push({
        method: req.method!,
        url: req.url!,
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}),
      });
      res.writeHead(status).end();
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

describe('LlmRelayClient', () => {
  it('registers a grant built from its own address and a fresh token, and removes it on close', async () => {
    const admin = await fakeAdmin();
    const client = new LlmRelayClient({ adminUrl: admin.url, publicUrl: 'http://100.64.0.1:8793', adminToken: 'adm' });
    let seenRelay: { url: string; token: string } | undefined;
    const grant = await client.open('rvb-1', 60_000, (relay) => {
      seenRelay = relay;
      return { m0: { baseUrl: 'https://gw.example/v1', key: 'sk-real' } };
    });
    expect(seenRelay).toEqual({ url: 'http://100.64.0.1:8793', token: grant.token });
    expect(grant.token).toMatch(/^[0-9a-f]{64}$/);
    const put = admin.calls[0]!;
    expect(put).toMatchObject({ method: 'PUT', url: '/grants/rvb-1', auth: 'Bearer adm' });
    // Only the token's hash travels; the relay never learns the token.
    expect(put.body).toMatchObject({
      tokenSha256: createHash('sha256').update(grant.token).digest('hex'),
      upstreams: { m0: { baseUrl: 'https://gw.example/v1', key: 'sk-real' } },
    });
    expect(JSON.stringify(put.body)).not.toContain(grant.token);
    await grant.close();
    expect(admin.calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/grants/rvb-1' });
  });

  it('a refused registration fails the review before anything is sent to the sandbox', async () => {
    const admin = await fakeAdmin(400);
    const client = new LlmRelayClient({ adminUrl: admin.url, publicUrl: 'http://r', adminToken: 'adm' });
    await expect(client.open('g', 1000, () => ({}))).rejects.toThrow(/refused grant/);
  });

  it('is configured from env, with the admin token derived from the agent secret', () => {
    expect(llmRelayFromEnv({})).toBeUndefined();
    expect(() => llmRelayFromEnv({ LLM_RELAY_ADMIN_URL: 'http://a', LLM_RELAY_PUBLIC_URL: 'http://b' })).toThrow(/SANDBOX_AGENT_SECRET/);
    expect(relayAdminToken('s')).toMatch(/^[0-9a-f]{64}$/);
    expect(relayAdminToken('s')).not.toBe(relayAdminToken('t'));
  });
});
