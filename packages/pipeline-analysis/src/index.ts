export type {
  DiagnosticSeverity,
  NormalizedDiagnostic,
  FailedJob,
  CiTrust,
  CiTrustInput,
  RootCause,
  CommentDecision,
} from './types.js';

export { redactSecrets } from './redact.js';
export type { RedactResult } from './redact.js';

export { normalizeDiagnostics } from './normalize.js';

export { correlateWithChanges } from './correlate.js';
export type { ChangedCode } from './correlate.js';

export { assessCiTrust } from './trust.js';

export { decideComment } from './dedup.js';
export type { CommentDecisionInput } from './dedup.js';

export { analyzeRootCause } from './root-cause.js';
export type { RootCauseDeps } from './root-cause.js';
