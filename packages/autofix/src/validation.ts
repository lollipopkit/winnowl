import type { ExecRequest, ExecResult } from '@reviewbot/sandbox';
import type { ValidationResult, ValidationStatus } from './types.js';

/** Passes when exitCode is 0 and it did not time out. */
export function toValidationResult(req: ExecRequest, res: ExecResult): ValidationResult {
  const passed = res.exitCode === 0 && !res.timedOut;
  const output = `${res.stdout}\n${res.stderr}`.trim();
  return {
    command: req.argv.join(' '),
    purpose: req.purpose,
    exitCode: res.exitCode,
    passed,
    timedOut: res.timedOut,
    durationMs: res.durationMs,
    ...(!passed && output ? { outputTail: output.slice(-OUTPUT_TAIL_CHARS) } : {}),
    evidence: res.evidence,
  };
}

const OUTPUT_TAIL_CHARS = 1500;

/** Empty → not-run; all pass → passed; all fail → failed; otherwise partial. */
export function computeValidationStatus(results: ValidationResult[]): ValidationStatus {
  if (results.length === 0) return 'not-run';
  const passed = results.filter((r) => r.passed).length;
  if (passed === results.length) return 'passed';
  if (passed === 0) return 'failed';
  return 'partial';
}

export function failedCommands(results: ValidationResult[]): string[] {
  return results.filter((r) => !r.passed).map((r) => r.command);
}
