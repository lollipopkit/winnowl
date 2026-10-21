export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface NormalizedDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: DiagnosticSeverity;
  message: string;
  /** Best effort (tsc/eslint/pytest/...). */
  tool?: string;
  onChangedCode?: boolean;
}

export interface FailedJob {
  jobId: string;
  name: string;
  conclusion: string;
  diagnostics: NormalizedDiagnostic[];
}

export interface CiTrust {
  /** All key conditions hold. */
  trustworthy: boolean;
  /** Shown to the user. */
  caveats: string[];
}

export interface CiTrustInput {
  jobHeadSha: string;
  currentHeadSha: string;
  logsComplete: boolean;
  flaky: boolean;
  /** Not an untrusted fork runner. */
  trustedEnvironment: boolean;
  /** The workflow was modified by an untrusted PR. */
  workflowModifiedByUntrustedPr: boolean;
}

export interface RootCause {
  summary: string;
  /** Which change in this revision caused it. */
  causingChange?: string;
  /** Groups of jobIds sharing a root cause. */
  sameRootCauseGroups: string[][];
  verifiableFix?: string;
  codeLocations: { file: string; line?: number }[];
  confidence: number;
}

export interface CommentDecision {
  shouldComment: boolean;
  /** Empty: no comment. */
  valueAdds: string[];
  reasons: string[];
}
