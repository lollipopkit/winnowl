import { request } from 'node:http';
import type { AgentTool } from '@reviewbot/agent-pi';
import { buildRunCommandTool, reviewCommand, type CommandOutcome, type CommandRunResult, type JudgeDeps } from '@reviewbot/command-gate';

/** What the judge is told about the GitHub Actions runner, in place of the platform sandbox. */
export const ACTIONS_COMMAND_ENVIRONMENT =
  'The sandbox is a scratch copy of one repository on a disposable GitHub Actions runner, with the toolchains the workflow set up. Commands run as an unprivileged user without credentials. Its network is not restricted, so a command that sends repository content or any other data to a host is a leak.';

const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 900;

/**
 * Runs a command through the host's command service (action/command-host.mjs) on a unix socket. Aborting
 * drops the request, which makes the host stop the command.
 */
export function hostCommand(socketPath: string, command: string, timeoutSec: number, signal?: AbortSignal): Promise<CommandRunResult> {
  const body = JSON.stringify({ command, timeoutSec });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/run',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        ...(signal ? { signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error(`command host: HTTP ${res.statusCode} ${text.slice(0, 300)}`));
          try {
            resolve(JSON.parse(text) as CommandRunResult);
          } catch {
            reject(new Error('command host: invalid response'));
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** `run_command` for review agents: gated, one command at a time, each decision in the Actions log. */
export function buildActionsCommandTools(o: {
  socketPath: string;
  task: string;
  judge: JudgeDeps;
  log: (line: string) => void;
  run?: typeof hostCommand;
}): AgentTool[] {
  const run = o.run ?? hostCommand;
  const previous: { command: string; verdict: 'allow' | 'deny' }[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const runNow = async (command: string, opts: { purpose: string; timeoutSec?: number; signal?: AbortSignal }): Promise<CommandOutcome> => {
    if (opts.signal?.aborted) return { decision: { verdict: 'deny', decidedBy: 'rule', rule: 'stopped', reason: 'the review was stopped' } };
    const decision = await reviewCommand(command, { task: o.task, purpose: opts.purpose, previous: [...previous] }, { ...o.judge, environment: ACTIONS_COMMAND_ENVIRONMENT });
    previous.push({ command, verdict: decision.verdict });
    o.log(`run_command [${decision.verdict}] ${command.replace(/\s+/g, ' ').slice(0, 300)}`);
    if (decision.verdict === 'deny') return { decision };
    const timeoutSec = Math.min(MAX_TIMEOUT_SEC, Math.max(10, opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC));
    try {
      return { decision, result: await run(o.socketPath, command, timeoutSec, opts.signal) };
    } catch (err) {
      return { decision, notRun: (err as Error).message };
    }
  };
  const tool = buildRunCommandTool({
    where: 'a scratch copy of the repository on the GitHub Actions runner (the toolchains the workflow set up; no credentials; your changes there are not part of the review)',
    defaultTimeoutSec: DEFAULT_TIMEOUT_SEC,
    maxTimeoutSec: MAX_TIMEOUT_SEC,
    run: (command, opts) => {
      const next = chain.then(() => runNow(command, opts));
      chain = next.catch(() => undefined);
      return next;
    },
  });
  return [tool];
}
