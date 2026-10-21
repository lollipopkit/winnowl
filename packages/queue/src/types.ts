export type JobType =
  | 'review_revision'
  | 'conversation_turn'
  // A comment addressed to the bot that is not a command.
  | 'conversation_agent'
  // `run <command>` in a sandbox on the pull request head.
  | 'run_command'
  | 'explain_finding'
  | 'reverify_findings'
  // Merge check after a finding was dismissed in the console.
  | 'recompute_gate'
  | 'action_execute'
  | 'pipeline_analyze'
  | 'issue_enrich'
  | 'post_merge_action'
  | 'security_scan'
  | 'relationship_discover'
  | 'cross_repo_analyze'
  // Detects App webhook config drift: a broken webhook is silent on our side.
  | 'webhook_config_check'
  // GitHub does not retry failed deliveries itself.
  | 'webhook_redeliver'
  | 'cross_tenant_intake'
  | 'notification_email'
  | 'global_learning_propose'
  | 'learning_propose'
  | 'memory_propose'
  | 'memory_consolidate'
  | 'ecosystem_fact_propose'
  | 'index_repository'
  | 'reconcile_publications'
  | 'sync_installation'
  | 'retention_sweep'
  | 'installation_erasure';

export type JobStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'completed'
  | 'failed'
  | 'superseded'
  | 'cancelled';

export const JOB_FAILURE_CLASSES = [
  'retryable_provider',
  'retryable_model',
  'retryable_runner',
  'environment_setup',
  'repository_invalid',
  'configuration_invalid',
  'budget_exhausted',
  'superseded',
  'policy_denied',
  'internal_bug',
] as const;

export type JobFailureClass = (typeof JOB_FAILURE_CLASSES)[number];

const RETRYABLE_CLASSES: ReadonlySet<JobFailureClass> = new Set<JobFailureClass>([
  'retryable_provider',
  'retryable_model',
  'retryable_runner',
  'environment_setup',
]);

export function isRetryableFailure(failureClass: JobFailureClass): boolean {
  return RETRYABLE_CLASSES.has(failureClass);
}

/** Class reported by an external worker; unknown values become `internal_bug` (not retried). */
export function isJobFailureClass(value: unknown): value is JobFailureClass {
  return typeof value === 'string' && (JOB_FAILURE_CLASSES as readonly string[]).includes(value);
}

/** Lives here rather than in backoff.ts to avoid an import cycle. */
export interface BackoffPolicy {
  /** Window after the nth failure is `base * 2^(n-1)` seconds, capped, then jittered. */
  baseSeconds: number;
  /** Max single wait in seconds. */
  capSeconds: number;
}

export interface Job {
  id: string;
  tenantId: string;
  type: string;
  status: JobStatus;
  priority: number;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  runnerSelector: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  cancellationRequested: boolean;
  leaseOwner: string | null;
  /** W3C trace carrier captured at enqueue; null = the job span starts its own trace. */
  traceCarrier?: Record<string, string>;
}

export interface EnqueueInput {
  tenantId: string;
  type: JobType;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  priority?: number;
  runnerSelector?: Record<string, unknown>;
  maxAttempts?: number;
  availableAt?: Date;
  /** Defaults to the current active span's carrier. */
  traceCarrier?: Record<string, string>;
}

export interface ClaimOptions {
  workerId: string;
  leaseSeconds: number;
  /** Only claim these job types. Omitted/empty = no restriction. */
  types?: string[];
  /** Never claim these job types (lets a catch-all lane pick up new types). Omitted/empty = no restriction; combines with `types`. */
  excludeTypes?: string[];
}

export interface FailInput {
  failureClass: JobFailureClass;
  message: string;
  /** Overrides the failureClass default. */
  retryable?: boolean;
  /** Overrides the failureClass default. */
  backoff?: BackoffPolicy;
}
