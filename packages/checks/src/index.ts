export type {
  CheckType,
  CheckStatus,
  EvidenceRef,
  CheckResult,
  MergeGateConfig,
} from './types.js';

export { evaluateDeterministicChecks } from './deterministic.js';
export type { DeterministicSignals } from './deterministic.js';

export { decideMergeGate } from './gate.js';
export type { MergeGateInput, MergeGateDecision, MergeGateReason } from './gate.js';

export { runAgenticCheck } from './agentic.js';
export type { AgenticCheckKind, AgenticCheckDeps, AgenticCheckInput } from './agentic.js';
