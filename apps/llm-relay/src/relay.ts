import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request as undiciRequest, type Dispatcher } from 'undici';

/**
 * Model relay: sandboxes call models through it so no key reaches a sandbox host. A request
 * `/r/<slot>/<path>` carrying a grant token is forwarded to the slot's upstream with the real key
 * in the same header. Grants are memory-only; the control plane re-registers them every few seconds.
 */
export interface GrantUpstream {
  baseUrl: string;
  key: string;
}

export interface GrantInput {
  tokenSha256: string;
  /** Absolute expiry (ms since epoch): the review's wall-clock limit. */
  expiresAt: number;
  upstreams: Record<string, GrantUpstream>;
}

interface Grant extends GrantInput {
  id: string;
  refreshedAt: number;
  inFlight: number;
}

const SLOT = /^[a-z0-9-]{1,32}$/;
const GRANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** A grant nobody refreshed for this long is gone (its runner stopped). */
export const GRANT_IDLE_MS = 60_000;
const MAX_IN_FLIGHT = 64;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Model calls stream for minutes; a silent upstream is cut after this. */
const UPSTREAM_IDLE_MS = 10 * 60_000;

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'via', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', 'x-real-ip', 'proxy-connection',
]);

export class GrantStore {
  private readonly byId = new Map<string, Grant>();
  private readonly byToken = new Map<string, Grant>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Registers or refreshes a grant. Validates everything: the input comes over the network. */
  put(id: string, input: GrantInput): void {
    if (!GRANT_ID.test(id) || !HEX64.test(input.tokenSha256) || !Number.isFinite(input.expiresAt)) {
      throw new Error('invalid grant');
    }
    const upstreams: Record<string, GrantUpstream> = {};
    for (const [slot, u] of Object.entries(input.upstreams ?? {})) {
      if (!SLOT.test(slot) || typeof u?.key !== 'string' || !u.key || typeof u.baseUrl !== 'string') {
        throw new Error(`invalid upstream ${slot}`);
      }
      const url = new URL(u.baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`invalid upstream ${slot}`);
      upstreams[slot] = { baseUrl: u.baseUrl.replace(/\/+$/, ''), key: u.key };
    }
    const prev = this.byId.get(id);
    if (prev && prev.tokenSha256 !== input.tokenSha256) this.byToken.delete(prev.tokenSha256);
    const fields = { tokenSha256: input.tokenSha256, expiresAt: input.expiresAt, upstreams, refreshedAt: this.now() };
    // Refreshed in place: requests in flight hold this object and release their slot on it.
    const grant: Grant = prev ? Object.assign(prev, fields) : { id, ...fields, inFlight: 0 };
    this.byId.set(id, grant);
    this.byToken.set(grant.tokenSha256, grant);
  }

  delete(id: string): void {
    const g = this.byId.get(id);
    if (!g) return;
    this.byId.delete(id);
    this.byToken.delete(g.tokenSha256);
  }

  forToken(token: string): Grant | undefined {
    const hash = createHash('sha256').update(token).digest('hex');
    // Looked up by the token's hash: nothing here compares secrets byte by byte.
    const g = this.byToken.get(hash);
    if (!g) return undefined;
    const now = this.now();
    if (now > g.expiresAt || now - g.refreshedAt > GRANT_IDLE_MS) {
      this.delete(g.id);
      return undefined;
    }
    return g;
  }

  sweep(): void {
    const now = this.now();
    for (const g of [...this.byId.values()]) {
      if (now > g.expiresAt || now - g.refreshedAt > GRANT_IDLE_MS) this.delete(g.id);
    }
  }

  get size(): number {
    return this.byId.size;
  }
}

export interface RelayOptions {
  store: GrantStore;
  dispatcher?: Dispatcher;
  log?: (fields: Record<string, unknown>) => void;
}

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

/** The token and the header it came in: the real key goes into that same header. */
function tokenOf(req: IncomingMessage): { token: string; header: 'authorization' | 'x-api-key' } | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer /i.test(auth)) return { token: auth.slice(7).trim(), header: 'authorization' };
  const key = req.headers['x-api-key'];
  if (typeof key === 'string' && key) return { token: key.trim(), header: 'x-api-key' };
  return undefined;
}

/**
 * The upstream URL for `/r/<slot><rest>`: `<rest>` may not leave the upstream's path (no `..`, raw
 * or encoded) — the key must only ever reach the endpoint it was granted for.
 */
export function upstreamUrl(baseUrl: string, rest: string, search: string): string | undefined {
  if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(rest)) return undefined;
  const base = new URL(baseUrl);
  const target = new URL(`${baseUrl}${rest}${search}`);
  if (target.origin !== base.origin) return undefined;
  const basePath = base.pathname.replace(/\/+$/, '');
  if (target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) return undefined;
  return target.toString();
}

export function createRelayHandler(opts: RelayOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const log = opts.log ?? (() => undefined);
  return (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log({ msg: 'relay request failed', error: (err as Error).message });
      reply(res, 502, 'relay failed');
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    // The raw path, not a parsed URL: parsing would turn `%2e%2e` into `..` before the check sees it.
    const raw = req.url ?? '/';
    const q = raw.indexOf('?');
    const rawPath = q < 0 ? raw : raw.slice(0, q);
    const search = q < 0 ? '' : raw.slice(q);
    const m = /^\/r\/([^/]+)(\/.*)?$/.exec(rawPath);
    if (!m || !SLOT.test(m[1]!)) return reply(res, 404, 'not found');
    const slot = m[1]!;
    const auth = tokenOf(req);
    const grant = auth ? opts.store.forToken(auth.token) : undefined;
    if (!auth || !grant) return reply(res, 401, 'invalid or expired relay token');
    const upstream = grant.upstreams[slot];
    if (!upstream) return reply(res, 404, `no upstream ${slot} in this grant`);
    const target = upstreamUrl(upstream.baseUrl, m[2] ?? '', search);
    if (!target) return reply(res, 400, 'path leaves the upstream');
    if (grant.inFlight >= MAX_IN_FLIGHT) {
      log({ msg: 'relay rejected', grant: grant.id, slot, status: 429, inFlight: grant.inFlight });
      return reply(res, 429, 'too many concurrent requests for this grant');
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || name === 'authorization' || name === 'x-api-key') continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    headers[auth.header] = auth.header === 'authorization' ? `Bearer ${upstream.key}` : upstream.key;

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    // Counted on the way through (a `data` listener on `req` would consume the body before undici).
    let received = 0;
    const body = hasBody
      ? req.pipe(
          new Transform({
            transform(chunk: Buffer, _enc, done) {
              received += chunk.length;
              done(received > MAX_BODY_BYTES ? new Error('request body too large') : null, chunk);
            },
          }),
        )
      : undefined;
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    grant.inFlight += 1;
    let status = 0;
    try {
      const upstreamRes = await undiciRequest(target, {
        method: (req.method ?? 'GET') as Dispatcher.HttpMethod,
        headers,
        ...(body ? { body } : {}),
        signal: abort.signal,
        headersTimeout: UPSTREAM_IDLE_MS,
        bodyTimeout: UPSTREAM_IDLE_MS,
        ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
      });
      status = upstreamRes.statusCode;
      const outHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        outHeaders[name] = value;
      }
      res.writeHead(status, outHeaders);
      await pipeline(upstreamRes.body, res);
    } catch (err) {
      if (!abort.signal.aborted) {
        status = status || 502;
        reply(res, 502, `upstream failed: ${(err as Error).message}`);
      }
    } finally {
      grant.inFlight -= 1;
      log({ msg: 'relayed', grant: grant.id, slot, method: req.method, status, ms: Date.now() - started, aborted: abort.signal.aborted });
    }
  }
}

/** Admin API (control plane only, on the internal network): PUT / DELETE `/grants/<id>`. */
export function createAdminHandler(opts: {
  store: GrantStore;
  /** sha256 hex of the admin bearer token. */
  adminTokenSha256: string;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const expected = Buffer.from(opts.adminTokenSha256);
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', grants: opts.store.size }));
      return;
    }
    const auth = req.headers.authorization ?? '';
    const given = Buffer.from(createHash('sha256').update(auth.replace(/^Bearer /i, '')).digest('hex'));
    if (!/^Bearer /i.test(auth) || !timingSafeEqual(given, expected)) return reply(res, 401, 'unauthorized');
    const m = /^\/grants\/([^/]+)$/.exec(url.pathname);
    if (!m) return reply(res, 404, 'not found');
    const id = decodeURIComponent(m[1]!);
    if (req.method === 'DELETE') {
      opts.store.delete(id);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'PUT') return reply(res, 405, 'method not allowed');
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        opts.store.put(id, JSON.parse(Buffer.concat(chunks).toString('utf8')) as GrantInput);
        res.writeHead(204).end();
      } catch (err) {
        reply(res, 400, (err as Error).message);
      }
    });
  };
}
