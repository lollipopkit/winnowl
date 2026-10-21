import type { ExecRequest, ExecResult, SandboxBackend, SandboxHandle } from '@reviewbot/sandbox';
import { checkAssertions, type Assertion, type ExecObservation } from '@reviewbot/verification';

/** Experiments only write to the scratch overlay (/workspace/scratch), never to pristine source. */

export const SCRATCH_DIR = '/workspace/scratch';

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : SCRATCH_DIR;
}

export function toObservation(result: ExecResult): ExecObservation {
  return { stdout: result.stdout, exitCode: result.exitCode, timedOut: result.timedOut };
}

export async function writeScratchFile(
  sandbox: SandboxBackend,
  handle: SandboxHandle,
  relPath: string,
  content: string,
): Promise<string> {
  const path = `${SCRATCH_DIR}/${relPath}`;
  await sandbox.exec(handle, {
    argv: ['mkdir', '-p', dirOf(path)],
    purpose: 'inspect',
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
  });
  await sandbox.putFile(handle, { path, content });
  return path;
}

export async function resetScratch(sandbox: SandboxBackend, handle: SandboxHandle): Promise<void> {
  await sandbox.exec(handle, {
    argv: ['rm', '-rf', SCRATCH_DIR],
    purpose: 'inspect',
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
  });
}

export interface OverlayExperiment {
  /** Relative to scratch. */
  testPath: string;
  testContent: string;
  command: ExecRequest;
  /** A zero exit code alone does not confirm anything. */
  assertions: Assertion[];
}

export async function runOverlayExperiment(
  sandbox: SandboxBackend,
  handle: SandboxHandle,
  experiment: OverlayExperiment,
): Promise<{ confirmed: boolean; observation: ExecObservation }> {
  await writeScratchFile(sandbox, handle, experiment.testPath, experiment.testContent);
  const result = await sandbox.exec(handle, experiment.command);
  const observation = toObservation(result);
  return {
    confirmed: experiment.assertions.length > 0 && checkAssertions(observation, experiment.assertions),
    observation,
  };
}
