import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();
const HEAD = 'a'.repeat(40);

describe('GitHub Actions runner endpoints (claim by OIDC, then per-run token)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let app: FastifyInstance;
  let idp: Server;
  let issuer = '';
  let key: KeyLike;

  const oidc = (claims: Record<string, unknown> = {}, audience = 'winnowl') =>
    new SignJWT({ repository_id: '900', ref: 'refs/pull/42/merge', event_name: 'pull_request', ...claims })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);

  const claim = async (token: string, headSha = HEAD) =>
    app.inject({ method: 'POST', url: '/v1/actions/claim', headers: { authorization: `Bearer ${token}` }, payload: { headSha } });

  const park = async (overrides: { head_sha?: string; change_request_number?: number } = {}) => {
    const id = uuidv7();
    await db
      .insertInto('actions_runs')
      .values({
        id,
        tenant_id: TENANT,
        job_id: uuidv7(),
        repository_id: REPO,
        change_request_number: overrides.change_request_number ?? 42,
        head_sha: overrides.head_sha ?? HEAD,
        executor_image: 'ghcr.io/lollipopkit/winnowl:sha-test',
        spec: { revisionSha: HEAD, marker: id },
      })
      .execute();
    return id;
  };

  const reviewJobs = async () =>
    (await db.selectFrom('jobs').select(['id']).where('type', '=', 'review_revision').where('tenant_id', '=', TENANT).execute()).length;

  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    key = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' };
    idp = createServer((req, res) => {
      res.writeHead(req.url?.endsWith('/.well-known/jwks') ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
    issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    const now = new Date();
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: now }).execute();
    await db
      .insertInto('provider_hosts')
      .values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'https://github.com', api_url: 'https://api.github.com', is_saas: true, created_at: now })
      .execute();
    await db
      .insertInto('installations')
      .values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '999', account_login: 'acme', status: 'active', created_at: now })
      .execute();
    await db
      .insertInto('repositories')
      .values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: now })
      .execute();
    await db
      .insertInto('change_requests')
      .values({ id: CR, tenant_id: TENANT, repository_id: REPO, native_id: '42', number: 42, kind: 'pull-request', source_branch: 'feat', target_branch: 'main', state: 'open', draft: false, created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('revisions')
      .values({ id: REV, tenant_id: TENANT, change_request_id: CR, base_sha: 'b'.repeat(40), head_sha: HEAD, merge_base_sha: null, source_branch: 'feat', target_branch: 'main', created_at: now })
      .execute();

    app = await buildServer({ db, quiet: true, actionsRunner: { oidcIssuer: issuer, env: { APP_VERSION: 'abc123' } } });
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((r) => idp?.close(r));
    await stop?.();
  });

  it('tells the action which executor image matches this server', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/actions/executor' });
    expect(res.json()).toEqual({ image: 'ghcr.io/lollipopkit/winnowl:sha-abc123' });
  });

  it('rejects tokens that are forged, for another audience, or not from a pull request', async () => {
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const forged = await new SignJWT({ repository_id: '900', ref: 'refs/pull/42/merge' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('winnowl')
      .setExpirationTime('5m')
      .sign(other.privateKey);
    expect((await claim(forged)).statusCode).toBe(401);
    expect((await claim(await oidc({}, 'someone-else'))).statusCode).toBe(401);
    const push = await claim(await oidc({ ref: 'refs/heads/main', event_name: 'push' }));
    expect(push.statusCode).toBe(400);
    expect((await claim(await oidc(), 'not-a-sha')).statusCode).toBe(400);
  });

  it('a repository that reviews on the platform says how to switch', async () => {
    const res = await claim(await oidc());
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('sandbox.runner: actions');
    expect((await claim(await oidc({ repository_id: '12345' }))).json().error).toBe('repository_unknown');
  });

  it('nothing parked: a re-run of the workflow requests one review, then waits for it', async () => {
    await db
      .insertInto('repository_settings')
      .values({ repository_id: REPO, tenant_id: TENANT, settings: {}, config_digest: null, source: 'panel', panel_settings: { sandbox: { runner: 'actions' } }, file_settings: null, updated_at: new Date() })
      .execute();
    const first = await claim(await oidc());
    expect(first.statusCode).toBe(404);
    expect(first.json().error).toBe('not_ready');
    expect(await reviewJobs()).toBe(1);
    expect((await claim(await oidc())).json().error).toBe('not_ready');
    expect(await reviewJobs()).toBe(1);
    // A head winnowl has not seen yet is not requested.
    expect((await claim(await oidc(), 'c'.repeat(40))).json().error).toBe('not_ready');
    expect(await reviewJobs()).toBe(1);
  });

  it('claims only the run of this repository, pull request and head; then heartbeat, cancel and complete', async () => {
    const elsewhere = await park({ change_request_number: 7 });
    const run = await park();
    const res = await claim(await oidc());
    expect(res.statusCode).toBe(200);
    const body = res.json() as { runId: string; token: string; spec: { marker: string } };
    expect(body.runId).toBe(run);
    expect(body.spec.marker).toBe(run);
    const stored = await db.selectFrom('actions_runs').select(['status', 'token_hash']).where('id', '=', run).executeTakeFirstOrThrow();
    expect(stored.status).toBe('running');
    expect(stored.token_hash).not.toContain(body.token);
    expect((await db.selectFrom('actions_runs').select('status').where('id', '=', elsewhere).executeTakeFirstOrThrow()).status).toBe('pending');
    // Claimed once only.
    expect((await claim(await oidc())).statusCode).toBe(404);

    const beat = (token: string, payload: unknown = {}) =>
      app.inject({ method: 'POST', url: `/v1/actions/runs/${run}/heartbeat`, headers: { authorization: `Bearer ${token}` }, payload });
    expect((await beat('wrong-token')).statusCode).toBe(401);
    const ok = await beat(body.token, { progress: { stage: 'dig', done: 1, total: 3 } });
    expect(ok.json()).toEqual({ cancel: false });
    expect((await db.selectFrom('actions_runs').select('progress').where('id', '=', run).executeTakeFirstOrThrow()).progress).toEqual({ stage: 'dig', done: 1, total: 3 });
    await db.updateTable('actions_runs').set({ cancel_requested: true }).where('id', '=', run).execute();
    expect((await beat(body.token)).json()).toEqual({ cancel: true });

    const complete = (payload: unknown) =>
      app.inject({ method: 'POST', url: `/v1/actions/runs/${run}/complete`, headers: { authorization: `Bearer ${body.token}` }, payload });
    expect((await complete({})).statusCode).toBe(400);
    expect((await complete({ output: { produced: { staged: [] }, pluginCalls: [] } })).statusCode).toBe(200);
    const done = await db.selectFrom('actions_runs').select(['status', 'output']).where('id', '=', run).executeTakeFirstOrThrow();
    expect(done.status).toBe('completed');
    expect(done.output).toEqual({ produced: { staged: [] }, pluginCalls: [] });
    expect((await beat(body.token)).statusCode).toBe(410);
  });
});
