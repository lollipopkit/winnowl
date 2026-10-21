export type RetentionClass =
  | 'checkout'
  | 'raw-command-logs'
  | 'agent-transcript'
  | 'review-artifacts'
  | 'finding-metadata'
  /** Langfuse traces; with `LLM_TRACE_BODIES` they contain prompt bodies, i.e. customer source. */
  | 'llm-traces'
  /** `review_progress` rows: display-only operational state. */
  | 'review-progress'
  | 'audit';

/** `immediate`: destroyed when the job ends; number: days. */
export type RetentionRule = 'immediate' | 'while-installation-active' | number;

export type RetentionPolicy = Record<RetentionClass, RetentionRule>;

export interface ErasureTask {
  installationId: string;
  resources: { class: RetentionClass; count: number }[];
  requestedAt: number;
  status: 'pending' | 'in-progress' | 'completed';
}

export interface ErasureAuditProof {
  installationId: string;
  requestedAt: number;
  completedAt?: number;
  erasedCounts: Record<string, number>;
  status: ErasureTask['status'];
}
