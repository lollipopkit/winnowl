import type { ColumnType, RawBuilder } from 'kysely';

/** Convention: every business query passes `tenant_id` explicitly; never rely on the session tenant. */

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export type Json<T> = ColumnType<T, T, T>;

/** pg reads bigint as a string. */
export type BigIntColumn = ColumnType<string, number | string, number | string>;

export interface TenantsTable {
  id: string;
  name: string;
  /** Reserved data region. */
  region: string | null;
  /** prompt | auto_accept | ignore. */
  global_learnings_policy: ColumnType<string, string | undefined, string>;
  /** Org-level config overlay (partial `.winnowl.yaml` shape). */
  settings: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown>
  >;
  created_at: Timestamp;
}

export interface UsersTable {
  id: string;
  email: string;
  display_name: string | null;
  created_at: Timestamp;
}

export interface MembershipsTable {
  id: string;
  tenant_id: string;
  user_id: string;
  role: string;
  /** active | invited; only active grants access. */
  status: string;
  created_at: Timestamp;
}

/** kind='oidc' (login sub) or 'provider' (forge user id). */
export interface UserIdentitiesTable {
  id: string;
  user_id: string;
  kind: string;
  /**
   * JWT `iss` for oidc; the forge origin (e.g. https://github.com) for provider.
   * Never the provider name: self-hosted instances share names, so matching by name would merge people.
   */
  issuer: string;
  subject: string;
  login: string | null;
  /** github | gitlab | forgejo; display only, never used for identity matching. */
  provider: ColumnType<string | null, string | null | undefined, string | null>;
  tenant_id: string | null;
  created_at: Timestamp;
}

/** Quota columns: null = unlimited. */
export interface PlansTable {
  id: string;
  key: string;
  name: string;
  model_tier: string;
  monthly_review_quota: number | null;
  monthly_token_quota: BigIntColumn | null;
  /** USD per period; null = uncapped. The primary limit; review/token quotas only guard against abuse. */
  monthly_cost_cap_usd: ColumnType<
    string | null,
    number | string | null | undefined,
    number | string | null
  >;
  /** Daily USD breaker. null = inherit env `DAILY_COST_CAP_USD`; 0 = explicitly uncapped. */
  daily_cost_cap_usd: ColumnType<
    string | null,
    number | string | null | undefined,
    number | string | null
  >;
  /** Per-review USD cap. null = inherit env; 0 = explicitly uncapped. */
  review_cost_cap_usd: ColumnType<
    string | null,
    number | string | null | undefined,
    number | string | null
  >;
  max_concurrency: number;
  features: Json<Record<string, unknown>>;
  active: boolean;
  created_at: Timestamp;
}

export interface SubscriptionsTable {
  id: string;
  tenant_id: string;
  plan_id: string;
  status: string;
  overage_policy: string;
  current_period_start: Timestamp;
  current_period_end: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TenantInvitesTable {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  token: string;
  invited_by: string | null;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  created_at: Timestamp;
}

export interface ProviderHostsTable {
  id: string;
  tenant_id: string;
  provider: string;
  base_url: string;
  api_url: string;
  is_saas: boolean;
  created_at: Timestamp;
}

/**
 * Self-hosted Forgejo login sources. Platform-level (no tenant_id): users log in before they have a tenant.
 * `issuer` is the normalized origin and doubles as the identity issuer; unique so an existing origin cannot be claimed.
 */
export interface LoginInstancesTable {
  id: string;
  provider: string;
  issuer: string;
  label: string;
  client_id: string;
  /** KMS envelope of client_secret; plaintext is never stored. */
  secret_envelope: Json<Record<string, unknown>>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Platform-level, no RLS; access is gated by isPlatformOperator. */
export interface PlatformSettingsTable {
  key: string;
  /** Always text; validated against PLATFORM_SETTINGS in packages/config. */
  value: string;
  updated_at: Timestamp;
  updated_by: string | null;
}

export interface PlatformSettingChangesTable {
  id: string;
  key: string;
  old_value: string | null;
  /** null = reset to environment/default. */
  new_value: string | null;
  actor: string | null;
  changed_at: ColumnType<Date, Date | undefined, never>;
}

export interface InstallationsTable {
  id: string;
  tenant_id: string;
  provider_host_id: string;
  native_id: string;
  account_login: string | null;
  status: string;
  created_at: Timestamp;
}

export interface RepositoriesTable {
  id: string;
  tenant_id: string;
  provider_host_id: string;
  installation_id: string;
  native_id: string;
  namespace: string;
  name: string;
  clone_url: string;
  default_branch: string;
  /** public | private; null = unknown, billed as private. */
  visibility: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface RepositorySettingsTable {
  repository_id: string;
  tenant_id: string;
  settings: Json<Record<string, unknown>>;
  config_digest: string | null;
  /** Last writer: panel (console PUT) | repo-file (mirrored by review, authoritative). */
  source: ColumnType<string, string | undefined, string>;
  /** Written only by console PUT; the review mirror never touches it. */
  panel_settings: Json<Record<string, unknown>> | null;
  /** The repository's `.winnowl.yaml` as written, set by review; null when it has none. */
  file_settings: Json<Record<string, unknown>> | null;
  updated_at: Timestamp;
}

export interface AuditEventsTable {
  id: string;
  tenant_id: string;
  actor: string | null;
  action: string;
  target: string | null;
  detail: Json<Record<string, unknown>>;
  created_at: Timestamp;
}

export interface ProviderEventsTable {
  id: string;
  tenant_id: string | null;
  provider: string;
  provider_host_id: string | null;
  installation_id: string | null;
  delivery_id: string | null;
  event_type: string;
  dedupe_key: string;
  signature_valid: boolean;
  headers: Json<Record<string, unknown>>;
  body: string;
  received_at: Timestamp;
  created_at: Timestamp;
}

export interface ChangeRequestsTable {
  id: string;
  tenant_id: string;
  repository_id: string;
  native_id: string;
  number: number;
  kind: string;
  title: ColumnType<string | null, string | null | undefined, string | null>;
  source_branch: string | null;
  target_branch: string | null;
  state: string;
  draft: boolean;
  author: string | null;
  /** Stable forge user id, matched against user-broadness subject_ref. */
  author_provider_id: string | null;
  /** As reported by the forge; null = unknown. */
  author_is_bot: boolean | null;
  reviewers: ColumnType<{ providerUserId: string; login: string }[], string | undefined, string>;
  labels: ColumnType<string[], string | undefined, string>;
  /** Blocks automatic reviews only; manual reviews always run. */
  auto_review_paused: ColumnType<boolean, boolean | undefined, boolean>;
  /** null = forge did not say. Only CRs with false can be a stack parent. */
  source_is_fork: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /** The CR this one is stacked on (its base branch is that CR's source branch). */
  stacked_on_change_request_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Final target branch of the whole stack (GitHub `stack.base.ref`). */
  stack_base_ref: ColumnType<string | null, string | null | undefined, string | null>;
  /** 1-based. */
  stack_position: ColumnType<number | null, number | null | undefined, number | null>;
  stack_size: ColumnType<number | null, number | null | undefined, number | null>;
  /** Provider-side lifecycle ordering watermark; delayed older deliveries cannot regress state. */
  last_provider_event_at: ColumnType<Date, Date | undefined, Date>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RevisionsTable {
  id: string;
  tenant_id: string;
  change_request_id: string;
  base_sha: string;
  head_sha: string;
  merge_base_sha: string | null;
  source_branch: string | null;
  target_branch: string | null;
  gate_state: ColumnType<'pass' | 'block' | null, 'pass' | 'block' | null | undefined, 'pass' | 'block' | null>;
  blocking_count: ColumnType<number | null, number | null | undefined, number | null>;
  created_at: Timestamp;
}

export interface DomainEventsTable {
  id: string;
  tenant_id: string | null;
  provider_event_id: string;
  type: string;
  repository_id: string | null;
  change_request_id: string | null;
  payload: Json<Record<string, unknown>>;
  status: string;
  created_at: Timestamp;
}

export interface RunnerPoolsTable {
  id: string;
  tenant_id: string | null;
  name: string;
  created_at: Timestamp;
}

export interface JobsTable {
  id: string;
  tenant_id: string;
  type: string;
  status: string;
  priority: number;
  dedupe_key: string | null;
  payload: Json<Record<string, unknown>>;
  runner_selector: Json<Record<string, unknown>>;
  /** W3C trace carrier (traceparent/tracestate) captured at enqueue; telemetry only. */
  trace_context: Json<Record<string, string>> | null;
  available_at: Timestamp;
  lease_owner: string | null;
  lease_expires_at: Timestamp | null;
  attempt_count: number;
  max_attempts: number;
  cancellation_requested: boolean;
  superseded_by: string | null;
  last_error: Json<Record<string, unknown>> | null;
  created_at: Timestamp;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
}

export interface JobAttemptsTable {
  id: string;
  job_id: string;
  attempt_number: number;
  worker_id: string | null;
  status: string;
  error: Json<Record<string, unknown>> | null;
  started_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface WorkersTable {
  id: string;
  pool_id: string;
  mode: string;
  version: string;
  capabilities: Json<Record<string, unknown>>;
  max_concurrency: number;
  running_jobs: number;
  last_heartbeat_at: Timestamp;
  registered_at: Timestamp;
}

/** Operator-registered release-notes pages ecosystem facts are extracted from. Global. */
export interface EcosystemFactFeedsTable {
  id: string;
  ecosystem: string;
  subject: string;
  url: string;
  label: string | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  last_fetched_at: Timestamp | null;
  last_content_hash: string | null;
  last_error: string | null;
  last_proposed: ColumnType<number, number | undefined, number>;
  last_cost_usd: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface ArtifactsTable {
  id: string;
  tenant_id: string;
  kind: string;
  storage_key: string;
  content_type: string | null;
  size_bytes: BigIntColumn;
  sha256: string;
  encrypted: boolean;
  expires_at: Timestamp | null;
  metadata: Json<Record<string, unknown>>;
  created_at: Timestamp;
}

export interface PublicationRecordsTable {
  id: string;
  tenant_id: string;
  repository_id: string | null;
  change_request_id: string | null;
  finding_id: string | null;
  revision_id: string | null;
  provider_host_id: string;
  kind: string;
  idempotency_key: string;
  provider_native_id: string | null;
  provider_url: string | null;
  state: string;
  request_digest: string;
  response: Json<Record<string, unknown>> | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface FindingsTable {
  id: string;
  tenant_id: string;
  repository_id: string;
  semantic_fingerprint: string;
  category: string;
  canonical_claim: string;
  lifecycle: string;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
}

/**
 * Which changed files of a PR were explored, and at which head. Used to prioritize unexplored files next round.
 * Keyed by path because scopes are re-planned by the LLM each round and do not match across rounds.
 */
export interface PrCoverageTable {
  tenant_id: string;
  change_request_id: string;
  path: string;
  /** If the file changed after this head it counts as uncovered again. */
  covered_at_sha: string;
  covered_at: ColumnType<Date, Date | undefined, Date>;
  /** Opaque digest of the current per-file PR material. NULL legacy rows are not reusable. */
  material_digest: string | null;
  /** Review configuration/prompt contract under which the file was explored. */
  review_contract_digest: string | null;
  /**
   * Other files the exploration read. Writers must JSON.stringify: node-pg turns JS arrays
   * into PG array literals, which jsonb rejects.
   */
  dependencies: ColumnType<string[], string | undefined, string>;
  /** Exploration note for the file (dig fileNotes). */
  note: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * In-flight review progress, one row per job (retries overwrite).
 * `stage` is an internal name shown raw only to operators.
 */
export interface ReviewProgressTable {
  job_id: string;
  tenant_id: string;
  repository_id: string;
  change_request_id: string;
  revision_id: string;
  stage: string;
  done: number | null;
  total: number | null;
  attempt: number;
  started_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  finished_at: Date | null;
}

export interface FindingOccurrencesTable {
  id: string;
  /** Needed for RLS: this table holds source snippets and RLS applies per table, not via findings. */
  tenant_id: string;
  finding_id: string;
  review_run_id: string | null;
  revision_id: string;
  state: string;
  severity: string;
  change_relation: string;
  confirmation: string;
  anchor: Json<Record<string, unknown>> | null;
  /** Flagged code window, used to re-anchor the finding on a new head. */
  anchor_text: string | null;
  blocking: ColumnType<boolean, boolean | undefined, boolean>;
  /**
   * Ordered reasons the finding was demoted from inline. Writers must JSON.stringify:
   * node-pg turns JS arrays into PG array literals, which jsonb rejects.
   */
  demotions: ColumnType<string[], string | undefined, string>;
  /** Written as a JSON string, like `demotions`. */
  evidence: ColumnType<unknown[], string | undefined, string>;
  /** quick-win | heavy-lift. */
  effort: ColumnType<string | null, string | null | undefined, string | null>;
  /** null = refuter did not run. */
  refuter_upheld: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  /** Claim for this round; null on old rows (readers fall back to findings.canonical_claim). */
  claim: ColumnType<string | null, string | null | undefined, string | null>;
  rationale: ColumnType<string | null, string | null | undefined, string | null>;
  suppress_reason: ColumnType<string | null, string | null | undefined, string | null>;
  code_context: ColumnType<{ startLine: number; lines: string[] } | null, string | null | undefined, string | null>;
  suggestion: ColumnType<{ startLine: number; endLine: number; replacement: string } | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface ProviderCredentialsTable {
  id: string;
  tenant_id: string;
  provider_host_id: string;
  kind: string;
  envelope: Json<Record<string, unknown>>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Service API keys at org (repo and user null), repo or user level; envelope is KMS ciphertext. */
export interface ServiceCredentialsTable {
  id: string;
  tenant_id: string;
  repository_id: string | null;
  user_id: string | null;
  service: string;
  envelope: Json<Record<string, unknown>>;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** BYOK: last review this configuration served. */
  last_used_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /** BYOK: why the last review that should have used it fell back to the platform key. */
  last_error: ColumnType<string | null, string | null | undefined, string | null>;
  last_error_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/** A command an agent asked to run in its sandbox and the gate's decision. */
export interface AgentCommandsTable {
  id: string;
  tenant_id: string;
  job_id: string | null;
  repository_id: string | null;
  command: string;
  purpose: string | null;
  verdict: 'allow' | 'deny';
  decided_by: 'rule' | 'judge';
  rule: string;
  reason: string;
  judge_cost_usd: ColumnType<string | null, number | null | undefined, number | null>;
  exit_code: number | null;
  timed_out: boolean | null;
  oom_killed: boolean | null;
  duration_ms: number | null;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  finished_at: Date | null;
}

/** A review whose executor runs in the repository's GitHub Actions (0021). */
export interface ActionsRunsTable {
  id: string;
  tenant_id: string;
  job_id: string;
  repository_id: string;
  change_request_number: number;
  head_sha: string;
  status: ColumnType<'pending' | 'running' | 'completed' | 'failed' | 'closed', 'pending' | undefined, 'running' | 'completed' | 'failed' | 'closed'>;
  executor_image: string;
  spec: Json<Record<string, unknown>> | null;
  token_hash: string | null;
  progress: Json<Record<string, unknown>> | null;
  cancel_requested: ColumnType<boolean, boolean | undefined, boolean>;
  output: Json<Record<string, unknown>> | null;
  error: Json<Record<string, unknown>> | null;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  claimed_at: Date | null;
  heartbeat_at: Date | null;
  finished_at: Date | null;
}

/** Measured sandbox needs per repository and kind. */
export interface SandboxSizingTable {
  tenant_id: string;
  repository_id: string;
  kind: string;
  memory_peak_mb: number;
  disk_peak_mb: number;
  samples: ColumnType<number, number | undefined, number>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/** A finding dismissed on one CR; undo = delete the row. */
export interface FindingDismissalsTable {
  id: string;
  tenant_id: string;
  finding_id: string;
  change_request_id: string;
  /** Forge actor id, falling back to login. */
  actor: string | null;
  /** Fingerprint without claim wording (repo+category+codeWindow). */
  weak_fingerprint: string | null;
  reason: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface ActionPlansTable {
  id: string;
  tenant_id: string;
  conversation_id: string;
  actor_id: string;
  approval_actor: string | null;
  approved_by_actor_id: string | null;
  /** Who approved and in which channel; null for legacy rows (= console). */
  approval_provenance: Json<Record<string, unknown>> | null;
  dedupe_key: string | null;
  revision_sha: string | null;
  actions: Json<unknown[]>;
  required_permissions: Json<string[]>;
  expires_at: Timestamp;
  status: string;
  execution_token: string | null;
  execution_expires_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface LearningProposalsTable {
  id: string;
  tenant_id: string;
  /** null for org/user broadness. */
  repository_id: string | null;
  broadness: string;
  locality: string;
  subject_ref: string | null;
  enforcement: string;
  selector: string | null;
  instruction: string;
  rationale: string;
  source_comment_ref: Json<Record<string, unknown>> | null;
  proposed_by: string;
  status: string;
  approved_by: string | null;
  approved_at: Timestamp | null;
  expires_at: Timestamp | null;
  version: number;
  /** Times injected into a review (incremented by markLearningsUsed). */
  usage_count: number;
  last_used_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Operator-curated learnings applied to every tenant; no tenant_id, so no RLS. */
export interface GlobalLearningsTable {
  id: string;
  locality: string;
  selector: string | null;
  instruction: string;
  rationale: string;
  enforcement: string;
  status: string;
  proposed_by: string;
  approved_by: string | null;
  version: number;
  /** operator | auto. */
  origin: string;
  /** 0-1 numeric (read as string); null for operator proposals. */
  confidence: ColumnType<string, number | string, number | string> | null;
  /** Multi-model deliberation record; auto proposals only. */
  deliberation: Json<Record<string, unknown>> | null;
  /** Operator-only: must be stripped from tenant projections. */
  source: Json<Record<string, unknown>> | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  expires_at: Timestamp | null;
}

/** Public, sourced facts about languages/SDKs/packages. Platform-level; proposed rows are operator-only. */
export interface EcosystemFactsTable {
  id: string;
  ecosystem: string;
  subject: string;
  versions: string | null;
  claim: string;
  detail: string | null;
  sources: Json<string[]>;
  /** proposed | approved | rejected */
  status: string;
  /** review | operator */
  origin: string;
  /** {tenantId,repositoryId,revisionId}; operator-only. */
  proposed_from: Json<Record<string, unknown>> | null;
  observed_at: Timestamp;
  expires_at: Timestamp | null;
  reviewed_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Tenant opt-in to default-broadness global learnings. No row = pending; mandatory ones ignore this table. */
export interface GlobalLearningAdoptionsTable {
  id: string;
  tenant_id: string;
  global_learning_id: string;
  /** accepted | declined */
  status: string;
  /** org | repo */
  scope: string;
  /** Set when scope = repo. */
  repository_ids: Json<string[]> | null;
  decided_by: string;
  decided_at: Timestamp;
}

/** Finding feedback aggregated by fingerprint; reaching a threshold proposes a learning. */
export interface FeedbacksTable {
  id: string;
  tenant_id: string;
  repository_id: string | null;
  fingerprint: string | null;
  finding_id: string | null;
  class: string;
  actor: string | null;
  note: string | null;
  created_at: Timestamp;
}

/**
 * Agent-curated repository memory, injected as non-binding reference; summary goes into the index, body is
 * loaded lazily via a tool. Only memories drafted from an outside commenter's words wait for an admin.
 */
export interface AgentMemoriesTable {
  id: string;
  tenant_id: string;
  repository_id: string;
  /** repo-quirk | false-positive-pattern | reviewer-pref | arch-note */
  kind: string;
  /** Normalized dedupe key, unique per (tenant, repo). */
  title: string;
  summary: string;
  body: string;
  /** Path glob; null = applies to the whole repository. */
  selector: string | null;
  /** Related memory ids. */
  links: Json<string[]>;
  /** Source revision, used for staleness checks. */
  origin_review_id: string | null;
  /** active | archived | proposed (awaiting an admin) | rejected */
  status: string;
  /** Forge login of the commenter a conversation memory came from. */
  proposed_by: string | null;
  /** Set on memories that needed an admin's approval (outside commenters); marks the approval queue. */
  source_comment_ref: Json<Record<string, unknown>> | null;
  expires_at: Timestamp | null;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ConversationsTable {
  id: string;
  tenant_id: string;
  target_kind: string;
  target_native_id: string;
  state: string;
  context_revision_sha: string | null;
  summary: string;
  active_task_id: string | null;
  repository_id: string | null;
  change_request_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ConversationMessagesTable {
  id: string;
  conversation_id: string;
  actor_login: string;
  body: string;
  created_at: Timestamp;
}

/** Contract changes in the source repository trigger read-only analysis of the target. */
export interface RepositoryRelationshipsTable {
  id: string;
  tenant_id: string;
  source_repository_id: string;
  target_repository_id: string;
  kind: string;
  instructions: string | null;
  enabled: boolean;
  /** proposed (auto-discovered, awaiting approval) | active | rejected (permanent veto). */
  status: string;
  /** `auto:discover` or a user sub; null for manual upserts. */
  proposed_by: string | null;
  rationale: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * Mutually confirmed; only sends notifications, never reads the other tenant's code.
 * RLS allows either side's tenant, so each side sees the row without a cross-tenant bypass.
 */
export interface CrossTenantRelationshipsTable {
  id: string;
  source_tenant_id: string;
  source_repository_id: string;
  target_tenant_id: string;
  target_repository_id: string;
  kind: string;
  /** proposed (by source) | active (approved by target) | rejected | revoked (by either side). */
  status: string;
  proposed_by: string | null;
  decided_by: string | null;
  rationale: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface NotificationsTable {
  id: string;
  tenant_id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  payload: Json<Record<string, unknown>>;
  read_at: Timestamp | null;
  emailed_at: Timestamp | null;
  email_claim_token: string | null;
  email_claim_expires_at: Timestamp | null;
  created_at: Timestamp;
}

/**
 * Cross-tenant handoff visible to both sides: source tenant INSERTs, target tenant SELECTs/UPDATEs,
 * each within its own RLS context.
 */
export interface CrossTenantEventsTable {
  id: string;
  relationship_id: string;
  source_tenant_id: string;
  source_repository_id: string;
  target_tenant_id: string;
  target_repository_id: string;
  kind: string;
  payload: Json<Record<string, unknown>>;
  /** Consumed by the target tenant = done. */
  consumed_at: Timestamp | null;
  /** Intake retries per event rather than per job run. */
  attempt_count: number;
  last_error: Json<Record<string, unknown>> | null;
  next_attempt_at: Timestamp | null;
  /** Gave up after the attempt cap. Terminal, like consumed_at. */
  failed_at: Timestamp | null;
  created_at: Timestamp;
}

/**
 * Model registry: names only. apiKey/baseUrl stay in env so secrets never reach the DB.
 * Platform-level, no RLS.
 */
export interface ModelsTable {
  id: string;
  /** A model is identified by provider + model_id (what is sent to the endpoint); reference rows by `id`. */
  provider: string;
  model_id: string;
  /**
   * Soft reference to `model_catalog` (no FK): a catalog sync may drop delisted entries without
   * touching the registry; a dangling reference falls back to the built-in catalog.
   */
  metadata_source: string | null;
  metadata_provider: string | null;
  metadata_model_id: string | null;
  active: boolean;
  sort: number;
  created_at: Timestamp;
}

/** Models allowed per plan and stage. No rows for a stage = the plan's default model. */
export interface PlanStageModelsTable {
  plan_id: string;
  stage: string;
  model_id: string;
  sort: ColumnType<number, number | undefined, number>;
}

/** Allocation strategy per plan and stage. Missing row = fill-first. */
export interface PlanStagePoliciesTable {
  plan_id: string;
  stage: string;
  strategy: ColumnType<string, string | undefined, string>;
  updated_at: Timestamp;
  updated_by: string | null;
}

/** Model specs synced from an external catalog (models.dev). The wire protocol comes from `models.provider`. */
export interface ModelCatalogTable {
  source: string;
  provider: string;
  model_id: string;
  name: string;
  context_window: number;
  max_tokens: number;
  reasoning: boolean;
  /** Comma-separated: 'text' or 'text,image'. */
  input: string;
  cost: ColumnType<ModelCatalogCost, string, string>;
  synced_at: Timestamp;
}

/** USD per million tokens. */
export interface ModelCatalogCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PendingInstallationsTable {
  id: string;
  provider: string;
  installation_native_id: string;
  account_login: string;
  installer_provider_user_id: string;
  installer_login: string;
  status: string;
  decided_by: string | null;
  decided_at: Timestamp | null;
  created_at: Timestamp;
}

export interface RepositoryPackagesTable {
  id: string;
  tenant_id: string;
  repository_id: string;
  /** provides | depends */
  role: string;
  /** npm | go | cargo | pypi */
  ecosystem: string;
  name: string;
  updated_at: Timestamp;
}

/** Token and cost totals per revision. */
export interface ReviewCostsTable {
  id: string;
  tenant_id: string;
  repository_id: string;
  change_request_id: string | null;
  revision_id: string;
  input_tokens: BigIntColumn;
  output_tokens: BigIntColumn;
  total_tokens: BigIntColumn;
  /** numeric(12,6), read as string. */
  cost_usd: ColumnType<string, number | string, number | string>;
  candidate_count: number;
  published_inline: number;
  scopes_total: number;
  scopes_complete: number;
  /** platform (hosted key) | byok (tenant key, tenant pays). */
  model_source: ColumnType<string, string | undefined, string>;
  /** Per-stage usage `{map,dig,synthesis,verify}`; absent stages omitted. */
  stage_usage: ColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null | undefined,
    Record<string, unknown> | null
  >;
  /** Per-stage wall time in ms; absent stages omitted. */
  stage_ms: ColumnType<
    Record<string, number> | null,
    Record<string, number> | null | undefined,
    Record<string, number> | null
  >;
  /** From a cancelled review: billed, but the revision does not count as reviewed. */
  cancelled: ColumnType<boolean, boolean | undefined, boolean | RawBuilder<boolean>>;
  /** Repository visibility snapshotted at billing time, so a later visibility change does not rewrite past bills. */
  repo_visibility: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface Database {
  artifacts: ArtifactsTable;
  publication_records: PublicationRecordsTable;
  provider_credentials: ProviderCredentialsTable;
  service_credentials: ServiceCredentialsTable;
  action_plans: ActionPlansTable;
  finding_dismissals: FindingDismissalsTable;
  learning_proposals: LearningProposalsTable;
  global_learnings: GlobalLearningsTable;
  global_learning_adoptions: GlobalLearningAdoptionsTable;
  ecosystem_facts: EcosystemFactsTable;
  feedbacks: FeedbacksTable;
  agent_memories: AgentMemoriesTable;
  conversations: ConversationsTable;
  conversation_messages: ConversationMessagesTable;
  review_costs: ReviewCostsTable;
  sandbox_sizing: SandboxSizingTable;
  agent_commands: AgentCommandsTable;
  actions_runs: ActionsRunsTable;
  repository_relationships: RepositoryRelationshipsTable;
  cross_tenant_relationships: CrossTenantRelationshipsTable;
  cross_tenant_events: CrossTenantEventsTable;
  notifications: NotificationsTable;
  pending_installations: PendingInstallationsTable;
  models: ModelsTable;
  model_catalog: ModelCatalogTable;
  plan_stage_models: PlanStageModelsTable;
  plan_stage_policies: PlanStagePoliciesTable;
  repository_packages: RepositoryPackagesTable;
  findings: FindingsTable;
  finding_occurrences: FindingOccurrencesTable;
  pr_coverage: PrCoverageTable;
  review_progress: ReviewProgressTable;
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  user_identities: UserIdentitiesTable;
  tenant_invites: TenantInvitesTable;
  plans: PlansTable;
  subscriptions: SubscriptionsTable;
  provider_hosts: ProviderHostsTable;
  login_instances: LoginInstancesTable;
  platform_settings: PlatformSettingsTable;
  platform_setting_changes: PlatformSettingChangesTable;
  installations: InstallationsTable;
  repositories: RepositoriesTable;
  repository_settings: RepositorySettingsTable;
  audit_events: AuditEventsTable;
  provider_events: ProviderEventsTable;
  change_requests: ChangeRequestsTable;
  revisions: RevisionsTable;
  domain_events: DomainEventsTable;
  runner_pools: RunnerPoolsTable;
  jobs: JobsTable;
  job_attempts: JobAttemptsTable;
  workers: WorkersTable;
  ecosystem_fact_feeds: EcosystemFactFeedsTable;
}
