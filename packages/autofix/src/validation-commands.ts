import type { ExecPurpose, ExecRequest } from '@reviewbot/sandbox';
import { detectValidationCommands } from './detect-validation.js';

/** Structural copy of `EffectiveRepositoryConfig['tools']`, so autofix does not depend on config. */
export interface ValidationToolsConfig {
  /** false = run only explicit `commands`. */
  auto_detect?: boolean;
  commands?: {
    setup?: readonly string[];
    build?: readonly string[];
    lint?: readonly string[];
    test?: readonly string[];
  };
  /** Non-empty = keep only these stages. */
  enabled?: readonly string[];
  /** Wins over `enabled`. */
  disabled?: readonly string[];
}

/** `setup` is dependency installation (ExecPurpose `bootstrap`). */
const STAGES = [
  { key: 'setup', purpose: 'bootstrap' as ExecPurpose, timeoutMs: 600_000 },
  { key: 'lint', purpose: 'lint' as ExecPurpose, timeoutMs: 120_000 },
  { key: 'build', purpose: 'build' as ExecPurpose, timeoutMs: 300_000 },
  { key: 'test', purpose: 'test' as ExecPurpose, timeoutMs: 300_000 },
] as const;

type StageKey = (typeof STAGES)[number]['key'];

function stageOf(purpose: ExecPurpose): StageKey | undefined {
  return STAGES.find((s) => s.purpose === purpose)?.key;
}

/**
 * Runs via `sh -lc` because users write shell expressions. This does not widen the trust boundary:
 * the sandbox already runs the repository's own code.
 */
function explicitCommand(command: string, purpose: ExecPurpose, timeoutMs: number): ExecRequest {
  return { argv: ['sh', '-lc', command], purpose, timeoutMs, maxOutputBytes: 200_000 };
}

/**
 * Auto-detected commands merged with explicit config: a non-empty `commands.<stage>` replaces that
 * stage's detected commands. Output is always ordered setup → lint → build → test.
 */
export async function resolveValidationCommands(
  readFile: (path: string) => Promise<string | null>,
  tools?: ValidationToolsConfig,
  isDir?: (path: string) => Promise<boolean>,
): Promise<ExecRequest[]> {
  const autoDetect = tools?.auto_detect ?? true;
  const detected = autoDetect ? await detectValidationCommands(readFile, isDir) : [];

  const allowed = new Set<StageKey>(STAGES.map((s) => s.key));
  const enabled = tools?.enabled ?? [];
  if (enabled.length > 0) {
    for (const s of STAGES) if (!enabled.includes(s.key)) allowed.delete(s.key);
  }
  for (const d of tools?.disabled ?? []) allowed.delete(d as StageKey);

  const out: ExecRequest[] = [];
  for (const stage of STAGES) {
    if (!allowed.has(stage.key)) continue;
    const explicit = tools?.commands?.[stage.key] ?? [];
    if (explicit.length > 0) {
      for (const cmd of explicit) {
        if (cmd.trim()) out.push(explicitCommand(cmd, stage.purpose, stage.timeoutMs));
      }
      continue;
    }
    out.push(...detected.filter((c) => stageOf(c.purpose) === stage.key));
  }
  return out;
}
