import { buildSourceTools, toolTextResult, Type, type AgentTool } from '@reviewbot/agent-pi';
import { commandOutputText, type AgentSandbox } from './agent-sandbox.js';

/**
 * Sandbox agent tools: reads over the sandbox tree (so the agent sees its own edits), edits and commands.
 * Every command passes the command gate; a denial returns the reason to the agent.
 */
export function buildAgentSandboxTools(box: AgentSandbox, changedPaths: readonly string[]): AgentTool[] {
  const runCommand: AgentTool = {
    name: 'run_command',
    description: [
      'Run a shell command in the repository root of your sandbox (a copy of the repository with its toolchains; network: package registries and GitHub downloads only; no credentials).',
      'Use it to install dependencies, build, lint, run tests, or reproduce a problem. Prefer the narrowest command (one test file rather than the whole suite).',
      'Every command is reviewed before it runs: publishing, pushing, uploading, background processes and anything unrelated to the task are refused, with the reason. Do not try to work around a refusal.',
      'Commands must finish: no servers or watchers. Default timeout 600 s, at most 1800 s.',
    ].join(' '),
    label: 'Run command',
    parameters: Type.Object({
      command: Type.String({ description: 'A shell command, run with sh -lc in the repository root.' }),
      purpose: Type.String({ description: 'One sentence: why this command serves the task.' }),
      timeoutSec: Type.Optional(Type.Integer({ minimum: 10, maximum: 1800 })),
    }),
    execute: async (_id, params) => {
      const p = params as { command: string; purpose: string; timeoutSec?: number };
      const outcome = await box.runCommand(p.command, { purpose: p.purpose, ...(p.timeoutSec ? { timeoutSec: p.timeoutSec } : {}) });
      return toolTextResult(commandOutputText(outcome), {
        verdict: outcome.decision.verdict,
        ...(outcome.result ? { exitCode: outcome.result.exitCode } : {}),
      });
    },
  };

  const writeFile: AgentTool = {
    name: 'write_file',
    description: 'Create or overwrite a file of the repository with the given content (whole file). For small changes to an existing file prefer edit_file.',
    label: 'Write file',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, params) => {
      const { path, content } = params as { path: string; content: string };
      try {
        await box.writeFile(path, content);
        return toolTextResult(`wrote ${path} (${content.length} characters)`, { ok: true });
      } catch (err) {
        return toolTextResult(`error: ${(err as Error).message}`, { ok: false });
      }
    },
  };

  const source = box.source(changedPaths);
  const editFile: AgentTool = {
    name: 'edit_file',
    description:
      'Replace an exact, unique piece of text in a file of the repository. `old` must match the file exactly (whitespace included) and occur once; include enough surrounding lines to make it unique.',
    label: 'Edit file',
    parameters: Type.Object({ path: Type.String(), old: Type.String({ minLength: 1 }), new: Type.String() }),
    execute: async (_id, params) => {
      const p = params as { path: string; old: string; new: string };
      const content = await source.readFile(p.path);
      if (content === null) return toolTextResult(`error: not found: ${p.path}`, { ok: false });
      const at = content.indexOf(p.old);
      if (at < 0) return toolTextResult('error: `old` does not occur in the file; read it again and copy the text exactly', { ok: false });
      if (content.indexOf(p.old, at + 1) >= 0) return toolTextResult('error: `old` occurs more than once; include more surrounding lines', { ok: false });
      try {
        await box.writeFile(p.path, content.slice(0, at) + p.new + content.slice(at + p.old.length));
        return toolTextResult(`edited ${p.path}`, { ok: true });
      } catch (err) {
        return toolTextResult(`error: ${(err as Error).message}`, { ok: false });
      }
    },
  };

  return [...buildSourceTools(source), editFile, writeFile, runCommand];
}
