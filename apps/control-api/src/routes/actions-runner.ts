import { randomBytes, timingSafeEqual } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { loadEffectiveConfig } from '@reviewbot/config';
import { runWithoutTenant, sql, type Db } from '@reviewbot/db';
import { enqueueManualReview } from '@reviewbot/queue';
import {
  ACTIONS_OIDC_AUDIENCE,
  actionsExecutorImage,
  type ActionsClaimResponse,
  type ActionsErrorBody,
  type ActionsErrorCode,
  type ActionsExecutorResponse,
  type ActionsHeartbeatResponse,
} from '@reviewbot/runner-protocol';

/**
 * Endpoints the winnowl GitHub Action calls. No session: the claim is authorized by a GitHub OIDC token
 * that names the repository and pull request, later calls by the per-run token handed out at claim.
 */

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const SHA = /^[0-9a-f]{40}$/;
// Executor output carries the whole ledger; larger than the API default.
const COMPLETE_BODY_LIMIT = 64 * 1024 * 1024;

export interface ActionsRunnerOptions {
  /** Test seam; production verifies against GitHub's issuer. */
  oidcIssuer?: string;
  env?: NodeJS.ProcessEnv;
}

interface PullRequestClaims {
  repositoryId: string;
  number: number;
}

function fail(reply: FastifyReply, status: number, error: ActionsErrorCode, message: string): FastifyReply {
  const body: ActionsErrorBody = { error, message };
  return reply.code(status).send(body);
}

const hashToken = (token: string): string => bytesToHex(blake3(new TextEncoder().encode(token)));

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Only pull request runs carry `refs/pull/<n>/merge|head`; that number is what binds the claim. */
function pullRequestClaims(payload: JWTPayload): PullRequestClaims | null {
  const repositoryId = typeof payload.repository_id === 'string' ? payload.repository_id : undefined;
  const ref = typeof payload.ref === 'string' ? payload.ref : '';
  const m = /^refs\/pull\/(\d+)\/(merge|head)$/.exec(ref);
  if (!repositoryId || !m) return null;
  return { repositoryId, number: Number(m[1]) };
}

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1];
}

export function registerActionsRunnerRoutes(app: FastifyInstance, db: Db, options: ActionsRunnerOptions = {}): void {
  const env = options.env ?? process.env;
  const issuer = (options.oidcIssuer ?? GITHUB_OIDC_ISSUER).replace(/\/+$/, '');
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));

  app.get('/v1/actions/executor', async () => {
    const body: ActionsExecutorResponse = { image: actionsExecutorImage(env) };
    return body;
  });

  app.post('/v1/actions/claim', async (req, reply) => {
    const token = bearer(req.headers.authorization);
    if (!token) return fail(reply, 401, 'invalid_token', 'missing GitHub OIDC token');
    let claims: PullRequestClaims | null;
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: ACTIONS_OIDC_AUDIENCE });
      claims = pullRequestClaims(payload);
    } catch {
      return fail(reply, 401, 'invalid_token', 'the GitHub OIDC token is invalid or expired');
    }
    if (!claims) {
      return fail(reply, 400, 'invalid_request', 'the workflow must run on a pull_request event');
    }
    const body = req.body as { headSha?: unknown; continuation?: unknown } | undefined;
    const headSha = body?.headSha;
    const continuation = body?.continuation === true;
    if (typeof headSha !== 'string' || !SHA.test(headSha)) {
      return fail(reply, 400, 'invalid_request', 'headSha must be the pull request head commit (40 hex)');
    }
    const { repositoryId, number } = claims;

    return runWithoutTenant(async () => {
      const runToken = randomBytes(32).toString('base64url');
      // Atomic: two runs of the same workflow cannot both claim one review.
      const claimed = await sql<{ id: string; spec: Record<string, unknown> }>`
        update actions_runs
        set status = 'running', token_hash = ${hashToken(runToken)}, claimed_at = now(), heartbeat_at = now()
        where id = (
          select a.id from actions_runs a
          join repositories r on r.id = a.repository_id
          join provider_hosts h on h.id = r.provider_host_id
          where h.provider = 'github' and h.is_saas and r.native_id = ${repositoryId}
            and a.change_request_number = ${number} and a.head_sha = ${headSha} and a.status = 'pending'
          order by a.created_at desc
          limit 1
          for update skip locked
        )
        returning id, spec
      `.execute(db);
      const run = claimed.rows[0];
      if (run) {
        const body: ActionsClaimResponse = { runId: run.id, token: runToken, spec: run.spec };
        return body;
      }
      return explainNothingToClaim(reply, db, { repositoryId, number, headSha, continuation });
    });
  });

  app.post('/v1/actions/runs/:id/heartbeat', async (req, reply) => {
    const run = await authorizeRun(req.params as { id: string }, req.headers.authorization);
    if ('status' in run) return fail(reply, run.status, run.error, run.message);
    const progress = (req.body as { progress?: unknown } | undefined)?.progress;
    const valid =
      progress && typeof progress === 'object' && typeof (progress as { stage?: unknown }).stage === 'string'
        ? (progress as Record<string, unknown>)
        : undefined;
    const row = await runWithoutTenant(() =>
      db
        .updateTable('actions_runs')
        .set({ heartbeat_at: new Date(), ...(valid ? { progress: valid } : {}) })
        .where('id', '=', run.id)
        .returning(['cancel_requested'])
        .executeTakeFirstOrThrow(),
    );
    const body: ActionsHeartbeatResponse = { cancel: row.cancel_requested };
    return body;
  });

  app.post('/v1/actions/runs/:id/complete', { bodyLimit: COMPLETE_BODY_LIMIT }, async (req, reply) => {
    const run = await authorizeRun(req.params as { id: string }, req.headers.authorization);
    if ('status' in run) return fail(reply, run.status, run.error, run.message);
    const body = req.body as { output?: unknown; error?: unknown } | undefined;
    const output = body?.output && typeof body.output === 'object' ? (body.output as Record<string, unknown>) : undefined;
    const error = body?.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : undefined;
    if (!output === !error) return fail(reply, 400, 'invalid_request', 'send exactly one of output or error');
    await runWithoutTenant(() =>
      db
        .updateTable('actions_runs')
        .set(
          output
            ? { status: 'completed', output, finished_at: new Date() }
            : { status: 'failed', error: error!, finished_at: new Date() },
        )
        .where('id', '=', run.id)
        .where('status', '=', 'running')
        .execute(),
    );
    return { ok: true };
  });

  async function authorizeRun(
    params: { id: string },
    authorization: string | undefined,
  ): Promise<{ id: string } | { status: number; error: ActionsErrorCode; message: string }> {
    const token = bearer(authorization);
    if (!token || !/^[0-9a-f-]{36}$/.test(params.id)) {
      return { status: 401, error: 'invalid_token', message: 'missing run token' };
    }
    const row = await runWithoutTenant(() =>
      db.selectFrom('actions_runs').select(['id', 'status', 'token_hash']).where('id', '=', params.id).executeTakeFirst(),
    );
    if (!row?.token_hash || !sameHash(row.token_hash, hashToken(token))) {
      return { status: 401, error: 'invalid_token', message: 'the run token does not match' };
    }
    if (row.status !== 'running') {
      return { status: 410, error: 'run_closed', message: 'winnowl is no longer waiting for this run' };
    }
    return { id: row.id };
  }
}

/**
 * Nothing parked for this head. The usual reason is timing (the runner is still preparing), so the action
 * retries on `not_ready`. A re-run of the workflow after the review finished or failed asks for a new one.
 */
async function explainNothingToClaim(
  reply: FastifyReply,
  db: Db,
  input: { repositoryId: string; number: number; headSha: string; continuation: boolean },
): Promise<FastifyReply> {
  const target = await db
    .selectFrom('change_requests as cr')
    .innerJoin('repositories as r', 'r.id', 'cr.repository_id')
    .innerJoin('provider_hosts as h', 'h.id', 'r.provider_host_id')
    .select(['cr.id as changeRequestId', 'cr.tenant_id as tenantId', 'cr.repository_id as repoId', 'cr.state'])
    .where('h.provider', '=', 'github')
    // GitHub Enterprise Server has its own OIDC issuer; its repository ids may collide with github.com's.
    .where('h.is_saas', '=', true)
    .where('r.native_id', '=', input.repositoryId)
    .where('cr.number', '=', input.number)
    .orderBy('cr.updated_at', 'desc')
    .executeTakeFirst();
  if (!target) {
    return fail(reply, 404, 'repository_unknown', 'winnowl is not installed on this repository, or has not seen this pull request yet');
  }
  const config = await loadEffectiveConfig(db, target.tenantId, target.repoId);
  if (config.sandbox.runner !== 'actions') {
    return fail(reply, 409, 'invalid_request', 'this repository reviews on the platform; set `sandbox.runner: actions` in .winnowl.yaml');
  }
  if (target.state !== 'open') return fail(reply, 410, 'run_closed', 'the pull request is not open');
  const latest = await db
    .selectFrom('revisions')
    .select(['id', 'head_sha'])
    .where('change_request_id', '=', target.changeRequestId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!latest || latest.head_sha !== input.headSha) {
    if (input.continuation) return fail(reply, 404, 'nothing_to_claim', 'the pull request has a newer commit');
    // The webhook for a new head may not have arrived yet.
    return fail(reply, 404, 'not_ready', 'winnowl has not seen this commit yet');
  }
  const active = await sql<{ id: string }>`
    select id from jobs
    where type = 'review_revision' and tenant_id = ${target.tenantId}::uuid
      and status in ('queued', 'leased', 'running')
      and payload->>'changeRequestId' = ${target.changeRequestId}
      and payload->>'headSha' = ${input.headSha}
    limit 1
  `.execute(db);
  if (active.rows.length === 0) {
    if (input.continuation) return fail(reply, 404, 'nothing_to_claim', 'the review of this commit is finished');
    await enqueueManualReview(db, {
      tenantId: target.tenantId,
      repositoryId: target.repoId,
      changeRequestId: target.changeRequestId,
      revisionId: latest.id,
      headSha: input.headSha,
    });
    return fail(reply, 404, 'not_ready', 'a new review was requested for this commit');
  }
  return fail(reply, 404, 'not_ready', 'the review is being prepared');
}
