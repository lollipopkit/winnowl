import type { ArtifactRef } from '@reviewbot/artifacts';
import type { CommandEvidence, ExecPurpose, ExecRequest } from '@reviewbot/sandbox';

export type FixKind =
  | 'autofix'
  | 'generate-tests'
  | 'generate-docs'
  | 'generate-diagram'
  | 'simplify'
  | 'resolve-conflict'
  | 'add-comments';

export const FIX_KINDS: readonly FixKind[] = [
  'autofix',
  'generate-tests',
  'generate-docs',
  'generate-diagram',
  'simplify',
  'resolve-conflict',
  'add-comments',
];

export interface FixPlan {
  kind: FixKind;
  findingIds: string[];
  constraints: string[];
  expectedFiles: string[];
  publicApiChangesAllowed: boolean;
  /** Run in order: format → build → test → targeted regression. */
  validationCommands: ExecRequest[];
}

export interface ValidationResult {
  command: string;
  purpose: ExecPurpose;
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  /** End of the output of a failed command (why it failed, for the note). */
  outputTail?: string;
  evidence: CommandEvidence;
}

export type ValidationStatus = 'passed' | 'failed' | 'partial' | 'not-run';

export type FixDelivery = 'artifact' | 'stacked-change-request';

export interface FixResult {
  findingIds: string[];
  patchArtifact: ArtifactRef;
  modifiedFiles: string[];
  validation: ValidationResult[];
  residualRisks: string[];
  confidence: number;
  validationStatus: ValidationStatus;
  delivery: FixDelivery;
}
