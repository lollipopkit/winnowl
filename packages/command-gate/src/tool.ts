import { toolTextResult, Type, type AgentTool } from '@reviewbot/agent-pi';
import type { GateDecision } from './gate.js';

export interface CommandRunResult {
  /** null when killed by a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  oomKilled?: boolean | undefined;
  durationMs: number;
}

export interface CommandOutcome {
  decision: GateDecision;
  /** Absent when the gate denied it or it could not run. */
  result?: CommandRunResult;
  /** The sandbox grew and the command ran a second time. */
  retried?: boolean;
  /** Why it did not run although allowed. */
  notRun?: string;
}

export function commandOutputText(o: CommandOutcome, max = 12_000): string {
  if (o.decision.verdict === 'deny') return `Command denied (${o.decision.decidedBy === 'judge' ? 'review' : 'rule'}): ${o.decision.reason}`;
  if (o.notRun || !o.result) return `Command not run: ${o.notRun ?? 'unknown reason'}`;
  const r = o.result;
  const combined = [r.stdout, r.stderr ? `[stderr]\n${r.stderr}` : ''].filter(Boolean).join('\n');
  const head = Math.floor(max / 4);
  let text = combined;
  if (combined.length > max) {
    // Cut points moved off the middle of a surrogate pair, so no half character reaches the agent.
    const lowAt = (i: number): boolean => i > 0 && i < combined.length && /[\uDC00-\uDFFF]/.test(combined[i]!);
    const end = lowAt(head) ? head - 1 : head;
    const tailStart = lowAt(combined.length - (max - head)) ? combined.length - (max - head) + 1 : combined.length - (max - head);
    text = `${combined.slice(0, end)}\n…[${tailStart - end} characters omitted]…\n${combined.slice(tailStart)}`;
  }
  const status = r.timedOut ? 'timed out' : r.oomKilled ? `killed: out of memory${o.retried ? ' (after growing the sandbox once)' : ''}` : `exit code ${r.exitCode}`;
  return `${status}${o.retried && !r.oomKilled ? ' (ran a second time after the sandbox grew)' : ''}, ${Math.round(r.durationMs / 1000)} s\n${text || '(no output)'}`;
}

/** `run_command` for an agent; every call goes through `run`, which must apply the gate. */
export function buildRunCommandTool(o: {
  /** Where commands run, for the agent (e.g. "your sandbox (a copy of the repository …)"). */
  where: string;
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  /** `signal`: the agent was stopped (deadline, cancel); a command still running should be stopped. */
  run: (command: string, opts: { purpose: string; timeoutSec?: number; signal?: AbortSignal }) => Promise<CommandOutcome>;
}): AgentTool {
  return {
    name: 'run_command',
    description: [
      `Run a shell command in the repository root of ${o.where}.`,
      'Use it to install dependencies, build, lint, run tests, or reproduce a problem. Prefer the narrowest command (one test file rather than the whole suite).',
      'Every command is reviewed before it runs: publishing, pushing, uploading, background processes and anything unrelated to the task are refused, with the reason. Do not try to work around a refusal.',
      `Commands must finish: no servers or watchers. Default timeout ${o.defaultTimeoutSec} s, at most ${o.maxTimeoutSec} s.`,
    ].join(' '),
    label: 'Run command',
    parameters: Type.Object({
      command: Type.String({ description: 'A shell command, run in the repository root.' }),
      purpose: Type.String({ description: 'One sentence: why this command serves the task.' }),
      timeoutSec: Type.Optional(Type.Integer({ minimum: 10, maximum: o.maxTimeoutSec })),
    }),
    execute: async (_id, params, signal) => {
      const p = params as { command: string; purpose: string; timeoutSec?: number };
      const outcome = await o.run(p.command, {
        purpose: p.purpose,
        ...(p.timeoutSec ? { timeoutSec: p.timeoutSec } : {}),
        ...(signal ? { signal } : {}),
      });
      return toolTextResult(commandOutputText(outcome), {
        verdict: outcome.decision.verdict,
        ...(outcome.result ? { exitCode: outcome.result.exitCode } : {}),
      });
    },
  };
}
