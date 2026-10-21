import type { ConfirmationLevel } from '@reviewbot/findings';

export type CheckType = 'deterministic' | 'agentic' | 'composite';

export type CheckStatus = 'pass' | 'warning' | 'fail' | 'unknown';

export interface EvidenceRef {
  kind: string;
  ref: string;
}

/** Bound to revisionSha; results of an older revision are never reused. */
export interface CheckResult {
  id: string;
  type: CheckType;
  status: CheckStatus;
  evidence: EvidenceRef[];
  explanation: string;
  revisionSha: string;
}

export interface MergeGateConfig {
  /** Default false: annotations only. */
  enabled: boolean;
  requiredConfirmation: ConfirmationLevel;
  /** Whether unknown (unverifiable environment) blocks; default false. */
  blockOnUnknown?: boolean;
}
