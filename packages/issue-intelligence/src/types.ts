import type { ChangeRelation } from '@reviewbot/domain';
import type { ConfirmationLevel, Severity } from '@reviewbot/findings';

export interface IssueEnrichment {
  duplicateOf: string[];
  relatedIssues: string[];
  relatedChangeRequests: string[];
  relatedCode: { file: string; symbol?: string }[];
  suggestedLabels: string[];
  suggestedOwners: string[];
  /** Questions about missing reproduction details. */
  reproductionQuestions: string[];
  feasibility: 'clear' | 'needs-clarification' | 'infeasible';
  riskClassification: 'low' | 'medium' | 'high';
}

export interface ImplementationPlan {
  understanding: string;
  assumptions: string[];
  relatedCode: { file: string; symbol?: string }[];
  likelyRootCause: string;
  changeSteps: string[];
  testSteps: string[];
  risks: string[];
  openQuestions: string[];
  /** Does not imply anything was verified. */
  canStartCodingAgent: boolean;
}

export interface AutoIssueConfig {
  enabled: boolean;
  /** Inclusive. */
  minSeverity: Severity;
  /** Per review. */
  maxPerReview: number;
  /** Default independently-verified. */
  minConfirmation?: ConfirmationLevel;
  /** Default ai-found. */
  label?: string;
}

export interface AutoIssueFinding {
  findingId: string;
  fingerprint: string;
  title: string;
  severity: Severity;
  changeRelation: ChangeRelation;
  confirmation: ConfirmationLevel;
  /** Required; never private artifact content. */
  evidencePermalink: string;
  evidenceSummary: string;
}

export interface AutoIssueCandidate {
  findingId: string;
  title: string;
  body: string;
  labels: string[];
}

export interface AutoIssueDecision {
  create: AutoIssueCandidate[];
  /** Excluded findings with reasons, so nothing is dropped silently. */
  skipped: { findingId: string; reason: string }[];
}
