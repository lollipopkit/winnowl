import type { ExecRequest, ExecResult, SandboxBackend, SandboxHandle, SandboxSpec } from '@reviewbot/sandbox';
import { resolveValidationCommands, type ValidationToolsConfig } from './validation-commands.js';
import type { ValidationResult, ValidationStatus } from './types.js';
import { computeValidationStatus, toValidationResult } from './validation.js';

export interface SandboxValidationInput {
  backend: SandboxBackend;
  spec: SandboxSpec;
  /** Patched files, paths relative to /workspace. */
  files: { path: string; content: string }[];
  commands: ExecRequest[];
}

export interface SandboxValidationOutcome {
  results: ValidationResult[];
  status: ValidationStatus;
}

export async function runValidationInSandbox(input: SandboxValidationInput): Promise<SandboxValidationOutcome> {
  const handle = await input.backend.create(input.spec);
  try {
    for (const f of input.files) {
      const path = f.path.startsWith('/') ? f.path : `/workspace/${f.path}`;
      await input.backend.putFile(handle, { path, content: f.content });
    }
    const results: ValidationResult[] = [];
    for (const cmd of input.commands) {
      const res = await input.backend.exec(handle, cmd);
      results.push(toValidationResult(cmd, res));
    }
    return { results, status: computeValidationStatus(results) };
  } finally {
    await input.backend.destroy(handle);
  }
}

export interface TreeValidationInput {
  backend: SandboxBackend;
  spec: SandboxSpec;
  /** Puts the patched tree into the sandbox at `/workspace`. */
  deliverTree: (handle: SandboxHandle, dest: string) => Promise<void>;
  /** Reads a file from the patched tree; null when missing. */
  readFile: (relPath: string) => Promise<string | null>;
  tools?: ValidationToolsConfig;
  /** After a failed command: grow the sandbox if it ran out of memory/disk; true = grown, rerun once. */
  grow?: (handle: SandboxHandle, result: ExecResult) => Promise<boolean>;
  /** Before the sandbox is removed, whatever the outcome (e.g. to record what it used). */
  beforeDestroy?: (handle: SandboxHandle) => Promise<void>;
}

/** No commands (unknown ecosystem, no explicit config) → not-run without creating a sandbox. */
export async function runTreeValidation(input: TreeValidationInput): Promise<SandboxValidationOutcome> {
  const commands = await resolveValidationCommands(input.readFile, input.tools);
  if (commands.length === 0) return { results: [], status: 'not-run' };
  const handle = await input.backend.create(input.spec);
  try {
    await input.deliverTree(handle, '/workspace');
    const results: ValidationResult[] = [];
    for (const cmd of commands) {
      let res = await input.backend.exec(handle, cmd);
      if (res.exitCode !== 0 && !res.timedOut && input.grow && (await input.grow(handle, res).catch(() => false))) {
        res = await input.backend.exec(handle, cmd);
      }
      results.push(toValidationResult(cmd, res));
    }
    return { results, status: computeValidationStatus(results) };
  } finally {
    try {
      await input.beforeDestroy?.(handle);
    } catch {
      // Bookkeeping only: the sandbox goes either way.
    }
    await input.backend.destroy(handle);
  }
}
