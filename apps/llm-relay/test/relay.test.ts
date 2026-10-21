import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminHandler, createRelayHandler, GrantStore, GRANT_IDLE_MS, upstreamUrl } from '../src/relay.js';

const TOKEN = 'job-token-abc';
const ADMIN = 'admin-token-xyz';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop()!.close(r));
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

interface Seen {
  method?: string;
  url?: string;
  authorization?: string;
  apiKey?: string;
  body?: string;
  closed?: boolean;
}

async function setup(clock = { now: 1_000_000 }) {
  const seen: Seen = {};
  const upstream = await listen((req, res) => {
    seen.method = req.method;
    seen.url = req.url;
    seen.authorization = req.headers.authorization;
    seen.apiKey = req.headers['x-api-key'] as string | undefined;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.body = Buffer.concat(chunks).toString();
      if (req.url?.endsWith('/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        const t = setTimeout(() => res.end('data: two\n\n'), 100);
        res.on('close', () => {
          clearTimeout(t);
          seen.closed = !res.writableFinished;
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const store = new GrantStore(() => clock.now);
  const relay = await listen(createRelayHandler({ store }));
  const admin = await listen(createAdminHandler({ store, adminTokenSha256: sha(ADMIN) }));
  const grant = (upstreams = { m0: { baseUrl: `${upstream}/v1`, key: 'sk-real' } }) =>
    fetch(`${admin}/grants/rvb-1`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tokenSha256: sha(TOKEN), expiresAt: clock.now + 3_600_000, upstreams }),
    });
  return { seen, relay, admin, store, grant, clock, upstream };
}

describe('llm-relay', () => {
  it('forwards with the real key in the header the token came in, path and body intact', async () => {
    const { seen, relay, grant } = await setup();
    expect((await grant()).status).toBe(204);
    const res = await fetch(`${relay}/r/m0/responses?x=1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{"model":"m"}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toMatchObject({ method: 'POST', url: '/v1/responses?x=1', authorization: 'Bearer sk-real', body: '{"model":"m"}' });

    await fetch(`${relay}/r/m0/v1/messages`, { method: 'POST', headers: { 'x-api-key': TOKEN }, body: '{}' });
    expect(seen.apiKey).toBe('sk-real');
    expect(seen.authorization).toBeUndefined();
  });

  it('streams responses as they come', async () => {
    const { relay, grant } = await setup();
    await grant();
    const res = await fetch(`${relay}/r/m0/stream`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe('data: one\n\n');
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    expect(rest).toBe('data: two\n\n');
  });

  it('a client that goes away cancels the upstream request', async () => {
    const { seen, relay, grant } = await setup();
    await grant();
    const abort = new AbortController();
    const res = await fetch(`${relay}/r/m0/stream`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '{}',
      signal: abort.signal,
    });
    await res.body!.getReader().read();
    abort.abort();
    await new Promise((r) => setTimeout(r, 150));
    expect(seen.closed).toBe(true);
  });

  it('refuses unknown tokens, unknown slots and paths that leave the upstream', async () => {
    const { seen, relay, grant } = await setup();
    await grant();
    // node:http sends the path as written (fetch would normalise `%2e%2e` away before sending).
    const call = (path: string, token = TOKEN) =>
      new Promise<number>((resolve, reject) => {
        const { hostname, port } = new URL(relay);
        const req = httpRequest({ hostname, port, path, method: 'POST', headers: { authorization: `Bearer ${token}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end('{}');
      });
    expect(await call('/r/m0/x', 'wrong')).toBe(401);
    expect(await call('/r/m9/x')).toBe(404);
    expect(await call('/r/m0/%2e%2e/admin')).toBe(400);
    expect(await call('/r/m0/..%2Fadmin')).toBe(400);
    expect(await call('/nope')).toBe(404);
    expect(seen.url).toBeUndefined();
  });

  it('a refresh during a request does not leak its concurrency slot', async () => {
    const { relay, grant, store } = await setup();
    await grant();
    const res = await fetch(`${relay}/r/m0/stream`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' });
    const reader = res.body!.getReader();
    await reader.read();
    expect(store.forToken(TOKEN)!.inFlight).toBe(1);
    await grant();
    while (!(await reader.read()).done);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.forToken(TOKEN)!.inFlight).toBe(0);
  });

  it('a grant expires when nobody refreshes it', async () => {
    const clock = { now: 1_000_000 };
    const { relay, grant } = await setup(clock);
    await grant();
    clock.now += GRANT_IDLE_MS + 1;
    const res = await fetch(`${relay}/r/m0/x`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('the admin API needs its token and validates grants', async () => {
    const { admin, grant, store } = await setup();
    const put = (auth: string, body: unknown) =>
      fetch(`${admin}/grants/g`, { method: 'PUT', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) }).then((r) => r.status);
    expect(await put('wrong', { tokenSha256: sha('t'), expiresAt: 1, upstreams: {} })).toBe(401);
    expect(await put(ADMIN, { tokenSha256: 'nothex', expiresAt: 1, upstreams: {} })).toBe(400);
    expect(await put(ADMIN, { tokenSha256: sha('t'), expiresAt: 1, upstreams: { m0: { baseUrl: 'file:///etc', key: 'k' } } })).toBe(400);
    await grant();
    expect(store.size).toBe(1);
    const del = await fetch(`${admin}/grants/rvb-1`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } });
    expect(del.status).toBe(204);
    expect(store.size).toBe(0);
  });
});

describe('upstreamUrl', () => {
  it.each([
    ['/responses', '', 'https://gw.example/v1/responses'],
    ['', '', 'https://gw.example/v1'],
    ['/chat/completions', '?a=b', 'https://gw.example/v1/chat/completions?a=b'],
  ])('%s%s', (rest, search, want) => {
    expect(upstreamUrl('https://gw.example/v1', rest, search)).toBe(want);
  });

  it.each(['/../admin', '/a/../../x', '/%2e%2e/x', '/a%2fb', '/a\\b'])('refuses %s', (rest) => {
    expect(upstreamUrl('https://gw.example/v1', rest, '')).toBeUndefined();
  });
});
