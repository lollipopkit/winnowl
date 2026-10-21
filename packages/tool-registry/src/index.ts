/** Raw tool output is never published directly; it goes through the finding pipeline. */

export type { ToolCategory, DiagnosticSeverity, NormalizedDiagnostic, ProjectContext } from './types.js';
export { detectProject } from './detect.js';
export type { ReadFile } from './detect.js';
export {
  differential,
  diagnosticFingerprint,
  newDiagnostics,
} from './differential.js';
export type { DiffClass, ClassifiedDiagnostic, DifferentialResult } from './differential.js';
