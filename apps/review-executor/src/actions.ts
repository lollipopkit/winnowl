import { setTimeout as sleep } from 'node:timers/promises';
import type { ReviewProgress } from '@reviewbot/review-orchestrator';
import { createModelSource } from '@reviewbot/agent-pi';
import {
  bindLocalCredentials,
  checkLocalModels,
  executorErrorReport,
  type ReviewExecutorOutput,
  type ReviewExecutorSpec,
} from '@reviewbot/review-runtime';
import {
  ACTIONS_OIDC_AUDIENCE,
  type ActionsClaimRequest,
  type ActionsClaimResponse,
  type ActionsCompleteRequest,
  type ActionsErrorBody,
  type ActionsHeartbeatRequest,
  type ActionsHeartbeatResponse,
} from '@reviewbot/runner-protocol';
import { buildActionsCommandTools } from './commands.js';
import { runExecutor } from './run.js';

/**
 * Entry used by the winnowl GitHub Action: claims the review parked for this pull request head, runs it on
 * the checked-out tree with the user's own model key, and posts the output back. Publishing stays on the
 * control plane. Logs go to the Actions log, so nothing secret is printed.
 */

const HEARTBEAT_MS = 10_000;
const CLAIM_RETRY_MS = 10_000;

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function oidcToken(): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    throw new Error('no GitHub OIDC token: the workflow needs `permissions: id-token: write` (fork pull requests never get one)');
  }
  const res = await fetch(`${url}&audience=${ACTIONS_OIDC_AUDIENCE}`, { headers: { authorization: `bearer ${bearer}` } });
  if (!res.ok) throw new Error(`GitHub OIDC token request failed: HTTP ${res.status}`);
  return ((await res.json()) as { value: string }).value;
}

async function post<T>(url: string, bearer: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: 'invalid_request', message: text.slice(0, 300) };
  }
  return { status: res.status, body: parsed as T };
}

async function claim(api: string, headSha: string, deadline: number): Promise<ActionsClaimResponse> {
  for (;;) {
    const req: ActionsClaimRequest = { headSha };
    const r = await post<ActionsClaimResponse | ActionsErrorBody>(`${api}/v1/actions/claim`, await oidcToken(), req);
    if (r.status === 200) return r.body as ActionsClaimResponse;
    const err = r.body as ActionsErrorBody;
    if (err.error === 'not_ready' && Date.now() < deadline) {
      console.log(`waiting for winnowl to prepare the review (${err.message})`);
      await sleep(CLAIM_RETRY_MS);
      continue;
    }
    throw new Error(`claim failed (HTTP ${r.status}, ${err.error}): ${err.message}`);
  }
}

/** Commands run only when the config allows them and the action could start its command host. */
function actionsCommandTools(spec: ReviewExecutorSpec): ReturnType<typeof buildActionsCommandTools> | undefined {
  if (!spec.runCommands) return undefined;
  const socketPath = process.env.WINNOWL_COMMAND_SOCKET?.trim();
  if (!socketPath) {
    console.log('::notice::this review runs no commands: the runner has no passwordless sudo to run them as a separate user');
    return undefined;
  }
  const { model, streamFn } = createModelSource(spec.model);
  const repo = process.env.GITHUB_REPOSITORY?.trim();
  return buildActionsCommandTools({
    socketPath,
    task: `Review a pull request${repo ? ` of ${repo}` : ''}: build, test or reproduce what the change does.`,
    judge: { model, streamFn },
    log: (line) => console.log(line),
  });
}

async function main(): Promise<void> {
  const api = (process.env.WINNOWL_API_URL?.trim() || 'https://winnowl-api.lollipopkit.com').replace(/\/+$/, '');
  const headSha = required('WINNOWL_HEAD_SHA');
  const worktreePath = required('WORKTREE_PATH');
  const claimTimeoutMs = (Number(process.env.WINNOWL_CLAIM_TIMEOUT_S) || 600) * 1000;

  const run = await claim(api, headSha, Date.now() + claimTimeoutMs);
  // GitHub masks the value in all later log lines.
  console.log(`::add-mask::${run.token}`);
  console.log(`claimed review run ${run.runId}`);
  const runUrl = `${api}/v1/actions/runs/${run.runId}`;
  const complete = (body: ActionsCompleteRequest) => post<unknown>(`${runUrl}/complete`, run.token, body);

  let progress: ReviewProgress | undefined;
  let cancelled = false;
  const beat = setInterval(() => {
    const body: ActionsHeartbeatRequest = progress
      ? {
          progress: {
            stage: progress.stage,
            ...(typeof progress.done === 'number' ? { done: progress.done } : {}),
            ...(typeof progress.total === 'number' ? { total: progress.total } : {}),
          },
        }
      : {};
    void post<ActionsHeartbeatResponse | ActionsErrorBody>(`${runUrl}/heartbeat`, run.token, body)
      .then((r) => {
        // A closed run (superseded, timed out) also stops the work.
        if ((r.status === 200 && (r.body as ActionsHeartbeatResponse).cancel) || r.status === 410) {
          if (!cancelled) console.log('winnowl asked to stop this review (a newer commit or a timeout)');
          cancelled = true;
        }
      })
      .catch(() => undefined);
  }, HEARTBEAT_MS);

  try {
    const spec = await checkLocalModels(bindLocalCredentials(run.spec as unknown as ReviewExecutorSpec, process.env), (m) =>
      console.log(`::warning::${m}`),
    );
    const commandTools = actionsCommandTools(spec);
    const output: ReviewExecutorOutput = await runExecutor({
      spec,
      worktreePath,
      ...(commandTools ? { commandTools } : {}),
      onProgress: (p) => {
        if (p.stage !== progress?.stage) console.log(`stage: ${p.stage}`);
        progress = p;
      },
      isCancelled: () => cancelled,
    });
    const r = await complete({ output: output as unknown as Record<string, unknown> });
    if (r.status !== 200) throw new Error(`posting the result failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    console.log('review finished; winnowl publishes it on the pull request');
  } catch (err) {
    await complete({ error: executorErrorReport(err) }).catch(() => undefined);
    throw err;
  } finally {
    clearInterval(beat);
  }
}

main().catch((err) => {
  console.error(`::error::${(err as Error)?.message ?? String(err)}`);
  process.exit(1);
});
