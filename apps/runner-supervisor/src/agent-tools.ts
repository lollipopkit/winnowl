import { buildSourceTools, toolTextResult, Type, type AgentTool } from '@reviewbot/agent-pi';
import { buildRunCommandTool } from '@reviewbot/command-gate';
import type { AgentSandbox } from './agent-sandbox.js';

/**
 * Sandbox agent tools: reads over the sandbox tree (so the agent sees its own edits), edits and commands.
 * Every command passes the command gate; a denial returns the reason to the agent.
 */
export function buildAgentSandboxTools(box: AgentSandbox, changedPaths: readonly string[]): AgentTool[] {
  const runCommand = buildRunCommandTool({
    where:
      'your sandbox (a copy of the repository with its toolchains; network: package registries and GitHub downloads only; no credentials)',
    defaultTimeoutSec: 600,
    maxTimeoutSec: 1800,
    run: (command, opts) => box.runCommand(command, opts),
  });

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
