/** Read client for control-api; types mirror its read-model JSON contract. */
import { authFetch } from './auth';
import { qs, type ListArgs, type Paged } from './paging';

export type ReviewRunState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ReviewRun {
  revisionId: string;
  headSha: string;
  createdAt: string;
  repository: string;
  repositoryId: string;
  changeNumber: number;
  changeKind: string;
  title: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  state: ReviewRunState;
  progress: { jobId: string; stepIndex: number | null; stepCount: number; countKind: ReviewCountKind; done: number | null; total: number | null; startedAt: string } | null;
  candidates: number | null;
  verified: number;
  published: number;
  topSeverity: string | null;
  gate: 'pass' | 'block' | null;
  blockingCount: number | null;
  costUsd: number | null;
}

/** `null` = the step has no countable unit, or it has not been counted yet. */
export type ReviewCountKind = 'areas' | 'findings' | null;

export type ReviewOutcome = 'done' | 'failed' | 'superseded';

/**
 * Progress of an in-flight review. The backend only exposes step index/count, never pipeline stage names;
 * `stepCount` lets the UI skip the step bar when it disagrees with the local labels instead of misaligning.
 */
export interface ReviewProgressItem {
  jobId: string;
  repository: string;
  changeNumber: number;
  sourceBranch: string | null;
  targetBranch: string | null;
  /** 0-based; null = finished, or the backend hit an unregistered stage. */
  stepIndex: number | null;
  stepCount: number;
  countKind: ReviewCountKind;
  done: number | null;
  total: number | null;
  attempt: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  outcome: ReviewOutcome | null;
  /** Only with `all=1` (operator), to tell tenants apart. */
  tenantName?: string;
}

/** A model reported by the upstream gateway's `/v1/models`; `catalog` is the models.dev spec matched by id, if any. */
export interface UpstreamModel {
  id: string;
  ownedBy?: string;
  registered: boolean;
  catalog?: CatalogEntryView;
}

export interface UpstreamModelList {
  items: UpstreamModel[];
  defaultProvider: string;
  /** Why the gateway's model list is unavailable; the UI falls back to manual entry. */
  unavailable?: string;
}

export interface ReviewFinding {
  findingId: string;
  claim: string;
  category: string;
  severity: string;
  state: string;
  changeRelation: string;
  confirmation: string;
  blocking: boolean;
  effort: string | null;
  lifecycle: string;
  path: string | null;
  line: number | null;
}

export interface ReviewDetail {
  run: ReviewRun;
  baseSha: string;
  changeState: string;
  areas: { complete: number; total: number } | null;
  findings: ReviewFinding[];
  risks: ReviewFinding[];
  suppressed: { findingId: string; claim: string; severity: string; reason: string | null }[];
  refutedCount: number;
  publications: { kind: string; state: string; providerUrl: string | null }[];
}

export interface Installation {
  id: string;
  accountLogin: string | null;
  status: string;
  createdAt: string;
}

export interface Repository {
  id: string;
  namespace: string;
  name: string;
  defaultBranch: string;
  forge: string;
  configSource: 'panel' | 'repo-file';
  profile: string;
  mergeGate: boolean;
  reviews30d: number;
  lastReviewAt: string | null;
}

export type AuditTargetKind = 'finding' | 'repository' | 'review' | 'action-plan' | 'rule';

export interface AuditEntry {
  id: string;
  actor: string | null;
  actorLabel: string | null;
  action: string;
  target: string | null;
  targetKind: AuditTargetKind | null;
  targetLabel: string | null;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link?: string;
  payload: Record<string, unknown>;
  readAt?: string;
  createdAt: string;
}

export interface RepositoryConfig {
  repositoryId: string;
  repository: string;
  settings: Record<string, unknown>;
  configDigest: string | null;
  /** Last writer: panel | repo-file (repo yaml wins; panel edits are overwritten by the next review). */
  source: string;
  updatedAt: string | null;
}

/** Settings replayed over the latest review's findings; an estimate. */
export interface ConfigPreview {
  basis: { revisionId: string; changeNumber: number; candidates: number } | null;
  inline: number;
  summary: number;
  notPosted: number;
  unverifiedRisks: number | null;
  unrelated: { count: number; mode: 'summary' | 'issue' | 'off' };
  blocking: number;
  gate: 'block' | 'pass' | 'off';
}

export interface FindingRow {
  id: string;
  claim: string;
  category: string;
  lifecycle: string;
  /** Heaviest severity across occurrences. */
  severity: string;
  occurrenceCount: number;
  lastSeenAt: string;
  repository: string;
  repositoryId: string;
  changeNumber: number | null;
  revisionId: string | null;
}

export interface FindingDetail {
  id: string;
  claim: string;
  category: string;
  lifecycle: string;
  repository: string;
  repositoryId: string;
  occurrence: {
    revisionId: string;
    headSha: string;
    changeNumber: number;
    changeRequestId: string;
    severity: string;
    state: string;
    changeRelation: string;
    confirmation: string;
    blocking: boolean;
    effort: string | null;
    refuterUpheld: boolean | null;
    rationale: string | null;
    evidence: unknown[];
    suppressReason: string | null;
    path: string | null;
    line: number | null;
    codeContext: { startLine: number; lines: string[] } | null;
    suggestion: { startLine: number; endLine: number; replacement: string } | null;
  } | null;
  dismissal: { reason: string | null; actor: string | null; at: string } | null;
  history: { revisionId: string; headSha: string; changeNumber: number; state: string; severity: string; createdAt: string }[];
}

export interface SuppressedRow {
  findingId: string;
  claim: string;
  category: string;
  severity: string;
  reason: string | null;
  repository: string;
  changeNumber: number;
  revisionId: string;
  createdAt: string;
}

export interface RunnerWorkerRow {
  id: string;
  pool: string;
  mode: string;
  version: string;
  runningJobs: number;
  maxConcurrency: number;
  lastHeartbeatAt: string;
}

export interface RunnersView {
  items: RunnerWorkerRow[];
  total: number;
  limit: number;
  offset: number;
  queuedJobs: number;
  runningJobs: number;
}

export interface ActionPlanRow {
  id: string;
  conversationId: string;
  actorId: string;
  revisionSha?: string;
  actions: { type: string; description: string }[];
  requiredPermissions: string[];
  expiresAt: number;
  status: string;
}

/** A command an agent asked to run in its sandbox, and what the command gate decided. */
export type InboxKind = 'plan' | 'rule' | 'memory' | 'recommendation' | 'dependency' | 'installation' | 'notification';

export interface InboxItem {
  id: string;
  kind: InboxKind;
  sourceId: string;
  createdAt: string;
  decided?: { outcome: string; at: string };
  plan?: {
    conversationId: string;
    actions: { type: string; description: string }[];
    requiredPermissions: string[];
    expiresAt: string;
    repository: string | null;
    changeNumber: number | null;
  };
  rule?: { instruction: string; rationale: string; broadness: string; repository: string | null; proposedBy: string };
  memory?: { kind: string; title: string; summary: string; body: string; repository: string | null; proposedBy: string | null };
  recommendation?: { instruction: string; rationale: string; selector: string | null };
  dependency?: { source: string; target: string; kind: string; rationale: string | null; proposedBy: string | null };
  installation?: { provider: string; accountLogin: string; installerLogin: string };
  notification?: { kind: string; title: string; body: string; link: string | null };
}

export interface AgentCommandRow {
  id: string;
  command: string;
  purpose?: string;
  verdict: 'allow' | 'deny';
  decidedBy: 'rule' | 'judge';
  rule: string;
  reason: string;
  exitCode?: number;
  timedOut?: boolean;
  oomKilled?: boolean;
  durationMs?: number;
  createdAt: string;
}

export interface ConversationRow {
  id: string;
  tenantId: string;
  target: { kind: string; nativeId: string };
  state: string;
  summary: string;
}

export type RuleScope = 'repository' | 'organization' | 'user' | 'platform';
export type RuleState = 'active' | 'proposed' | 'inactive';

/** Tenant and platform rules in one list. */
export interface RuleRow {
  id: string;
  scope: RuleScope;
  repositories: string[];
  instruction: string;
  rationale: string;
  selector: string | null;
  status: string;
  state: RuleState;
  createdAt: string;
  expiresAt: string | null;
  usageCount: number | null;
}

export interface GlobalLearningVote {
  model: string;
  decision: string;
  confidence: number;
  reasoning: string;
}

export interface GlobalLearningDeliberation {
  signal?: { kind: string; note: string };
  evidence: string[];
  draftModel: string;
  panel: GlobalLearningVote[];
  aggregate: { confidence: number; approvals: number; total: number };
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

/** Tenant inbox item; field allow-list, no source/deliberation. */
export type GlobalLearningsPolicy = 'prompt' | 'auto_accept' | 'ignore';

/** Release-notes page facts are extracted from. */
export interface FactFeedRow {
  id: string;
  ecosystem: string;
  subject: string;
  url: string;
  label?: string;
  enabled: boolean;
  createdBy: string;
  lastFetchedAt?: string;
  lastError?: string;
  lastProposed: number;
  lastCostUsd?: number;
}

export interface EcosystemFactRow {
  id: string;
  ecosystem: string;
  subject: string;
  versions?: string;
  claim: string;
  detail?: string;
  sources: string[];
  status: 'proposed' | 'approved' | 'rejected';
  origin: 'review' | 'operator' | 'feed';
  proposedFrom?: { tenantId: string; repositoryId: string; revisionId: string } | { feedId: string; url: string };
  observedAt: string;
  expiresAt?: string;
  reviewedBy?: string;
  createdAt: string;
}

export interface GlobalLearningRow {
  id: string;
  locality: string;
  selector?: string;
  instruction: string;
  rationale: string;
  enforcement: string;
  status: string;
  proposedBy: string;
  approvedBy?: string;
  version: number;
  origin: string;
  confidence?: number;
  deliberation?: GlobalLearningDeliberation;
  /** Epoch ms; past = no longer injected nor offered for adoption. */
  expiresAt?: number;
}

export interface UsageSummary {
  totals: { reviews: number; totalTokens: number; costUsd: number };
  byRepository: { repository: string; reviews: number; totalTokens: number; costUsd: number }[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await authFetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return (await res.json()) as T;
}

export interface ApiErrorCode {
  /** The endpoint's error code (`invalid_byok_config`, …). */
  error?: string;
  /** Finer cause for pages that explain it (`key_rejected`, `model_unavailable`, …). */
  reason?: string;
  /** The input it is about. */
  field?: string;
}

/** A refused write. The message stays the generic `status — code: field`; pages that can explain the refusal read `code`. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ApiErrorCode,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function writeJson<T>(method: 'PUT' | 'POST' | 'DELETE', path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    let code: ApiErrorCode = {};
    try {
      // Append the offending value to the error code (`arm_key_invalid: gpt-5.6-luna`) so the reader knows which entry failed.
      const body = (await res.json()) as { message?: string; error?: string; reason?: string; key?: string; field?: string };
      detail = body.error ?? body.message ?? '';
      const which = body.key ?? body.field;
      if (detail && which) detail = `${detail}: ${which}`;
      // Validation errors name the offending path in `message`; the code alone does not say what to fix.
      else if (body.error && body.message) detail = `${body.error}: ${body.message}`;
      code = { ...(body.error ? { error: body.error } : {}), ...(body.reason ? { reason: body.reason } : {}), ...(body.field ? { field: body.field } : {}) };
    } catch {
      detail = res.statusText;
    }
    throw new ApiError(`${res.status} — ${detail || path}`, res.status, code);
  }
  // 204 responses (e.g. credential endpoints) have no body.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
const putJson = <T>(path: string, body: unknown): Promise<T> => writeJson<T>('PUT', path, body);
const postJson = <T>(path: string, body: unknown): Promise<T> => writeJson<T>('POST', path, body);
const delJson = <T>(path: string, body: unknown): Promise<T> => writeJson<T>('DELETE', path, body);

export interface PluginInfo {
  name: string;
  publisher: string;
  upstream: string | null;
}

export interface TenantPluginSettings {
  plugins?: Record<string, { enabled?: boolean }>;
}

/** Non-secret BYOK metadata and usage status; never contains apiKey. */
export interface ByokMeta {
  provider: string;
  model: string;
  modelQuality?: string;
  modelCheap?: string;
  templateModel?: string;
  lastUsedAt?: string;
  /** Why the last review that should have used it ran on the platform key (only while newer than the last use). */
  lastError?: 'unreadable' | 'provider_disabled' | 'model_unknown';
  lastErrorAt?: string;
}

export interface ByokView {
  byok: ByokMeta | null;
  /** Repository scope without its own: the organisation's, which its reviews use. */
  inherited?: ByokMeta | null;
  /** Organisation scope: repositories with their own configuration. */
  repositories?: string[];
  providers: string[];
}

/** What is saved; `apiKey` omitted keeps the stored key of the same provider. */
export interface ByokInput {
  provider: string;
  model: string;
  apiKey?: string;
  modelQuality?: string;
  modelCheap?: string;
  templateModel?: string;
}

/** A model the key can use; `known`: the platform has its specification (otherwise it needs a template model). */
export interface ByokModelOption {
  id: string;
  known: boolean;
}

export interface ServiceCredentialMeta {
  service: string;
  scope: 'org' | 'repo' | 'user';
  repositoryId: string | null;
  userId: string | null;
  updatedAt: string;
}


/** Current identity; single source for nav trimming and tenant switching. */
export interface Me {
  role: string;
  tenantId: string | null;
  userId: string | null;
  /** Real email for display; placeholder emails are nulled by the backend. */
  email: string | null;
  displayName: string | null;
  isOperator: boolean;
  /** db = from memberships (member features available); claims = read from the JWT (those features disabled). */
  memberships: { tenantId: string; tenantName: string; role: string }[];
  /** The user's own installation awaiting approval (only queried when memberships is empty). */
  pendingInstallation: { provider: string; accountLogin: string; createdAt: string } | null;
  /** Configured App install URL; null hides the onboarding button. */
  installUrl: string | null;
}

export interface MemberRow {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  createdAt: string;
}

export interface InviteRow {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

export interface SubscriptionView {
  plan: {
    key: string;
    name: string;
    modelTier: string;
    /** Billing-period cost cap (USD); null = uncapped. */
    monthlyCostCapUsd: number | null;
    monthlyReviewQuota: number | null;
    monthlyTokenQuota: number | null;
    maxConcurrency: number;
  };
  overageAction: string;
  periodStart: string;
  /** Exclusive. */
  periodEnd: string;
  usage: { costUsd: number; reviews: number; tokens: number };
  withinQuota: boolean;
}

/** Linked external identity. `issuer` is the forge origin: identities match by host, not provider name. */
export interface LinkedIdentityView {
  id: string;
  kind: 'oidc' | 'provider';
  issuer: string;
  subject: string;
  login?: string;
  provider?: string;
  createdAt: string;
}

/** Registered self-hosted Forgejo login source; client_secret never reaches the frontend. */
export interface LoginInstanceView {
  id: string;
  provider: string;
  issuer: string;
  label: string;
  clientId: string;
  createdAt: string;
}

/** Installation awaiting admission: off-allow-list accounts can install the public App, which only records it here. */
export interface PendingInstallationView {
  id: string;
  provider: string;
  installationNativeId: string;
  accountLogin: string;
  installerLogin: string;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** `source`: set in the UI, from env, or the built-in default. */
export interface PlatformSettingChange {
  /** null = environment/default. */
  oldValue: string | null;
  newValue: string | null;
  actor: string | null;
  changedAt: string;
}

export interface PlatformSettingView {
  key: string;
  value: string;
  source: 'database' | 'environment' | 'default';
  values: string[];
  description: string;
  /** Fallback env var name, shown so rollback can be done without the console. */
  env: string;
  updatedAt?: string;
  updatedBy?: string | null;
}

/** Model registry entry; baseUrl/apiKey live only in env. */
export interface RegisteredModelView {
  /** Row identity; referenced by it, displayed as `provider/modelId`. */
  id: string;
  provider: string;
  modelId: string;
  /** Points at a model_catalog row; metadata is empty when the row is missing. */
  metadataRef?: { source: string; provider: string; modelId: string };
  metadata?: ModelMetadataView;
  active: boolean;
  sort: number;
}

/** Model spec, used locally only; requests send just modelId. */
export interface ModelMetadataView {
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** Identity is `source` + `provider` + `modelId`. */
export interface CatalogEntryView extends ModelMetadataView {
  source: string;
  provider: string;
  modelId: string;
}

/** Cost cap and concurrency; models per stage are in `planStageModels`. */
export interface PlatformPlanView {
  id: string;
  key: string;
  name: string;
  modelTier: string;
  monthlyCostCapUsd: number | null;
  monthlyReviewQuota: number | null;
  monthlyTokenQuota: number | null;
  maxConcurrency: number;
  active: boolean;
}

/** Models this tenant runs; read-only, chosen by the platform. */
export interface PlanModelsView {
  planKey: string;
  allowed: { id: string; provider: string; modelId: string }[];
  /** Row id used when a stage has no model; null = registry empty (env/tier deployment). */
  effectiveId: string | null;
}

/** proposed = auto-discovered, awaiting approval; active; rejected = permanent veto. */
export interface RelationshipRow {
  id: string;
  sourceRepositoryId: string;
  targetRepositoryId: string;
  kind: string;
  instructions?: string;
  enabled: boolean;
  status: 'proposed' | 'active' | 'rejected';
  proposedBy?: string;
  rationale?: string;
}






export interface DashboardSummary {
  since: string;
  reviews: number;
  activeRepositories: number;
  /** Per review run; each stage is a subset of the previous one. */
  funnel: { candidates: number; verified: number; published: number; fixed: number };
  openBySeverity: { severity: string; count: number }[];
  recentPublished: {
    findingId: string;
    claim: string;
    severity: string;
    path: string | null;
    line: number | null;
    repository: string;
    changeNumber: number;
    revisionId: string;
    createdAt: string;
  }[];
}

export const api = {
  me: (): Promise<Me> => getJson('/v1/me'),
  members: (): Promise<MemberRow[]> => getJson('/v1/members'),
  invites: (): Promise<InviteRow[]> => getJson('/v1/invites'),
  inviteMember: (body: { email: string; role: string; locale?: string }): Promise<InviteRow & { token: string; emailSent: boolean }> => postJson('/v1/members/invite', body),
  acceptInvite: (token: string): Promise<{ tenantId: string; role: string }> => postJson(`/v1/invites/${token}/accept`, {}),
  changeMemberRole: (userId: string, role: string): Promise<{ userId: string; role: string }> => postJson(`/v1/members/${userId}/role`, { role }),
  removeMember: (userId: string): Promise<{ removed: string }> => delJson(`/v1/members/${userId}`, undefined),
  subscription: (): Promise<SubscriptionView> => getJson('/v1/subscription'),
  subscriptionModels: (): Promise<PlanModelsView> => getJson('/v1/subscription/models'),
  identities: (): Promise<{ items: LinkedIdentityView[] }> => getJson('/v1/account/identities'),
  unlinkIdentity: (id: string): Promise<{ ok: boolean }> => delJson(`/v1/account/identities/${id}`, undefined),
  loginInstances: (): Promise<{ items: LoginInstanceView[] }> => getJson('/v1/auth/instances'),
  addLoginInstance: (input: { url: string; label?: string; clientId: string; clientSecret: string }): Promise<LoginInstanceView> =>
    postJson('/v1/auth/instances', input),
  deleteLoginInstance: (id: string): Promise<{ ok: boolean }> => delJson(`/v1/auth/instances/${id}`, undefined),
  pendingInstallations: (status?: string): Promise<{ items: PendingInstallationView[] }> =>
    getJson(`/v1/pending-installations${status ? `?status=${status}` : ''}`),
  decidePendingInstallation: (id: string, action: 'approve' | 'reject'): Promise<{ ok: boolean; status: string }> =>
    postJson(`/v1/pending-installations/${id}/${action}`, {}),
  platformSettings: (): Promise<{ items: PlatformSettingView[] }> => getJson('/v1/platform/settings'),
  savePlatformSetting: (key: string, value: string): Promise<{ ok: boolean }> => putJson(`/v1/platform/settings/${key}`, { value }),
  /** Deleting reverts to the deployment env/default value, not to empty. */
  resetPlatformSetting: (key: string): Promise<{ ok: boolean }> => delJson(`/v1/platform/settings/${key}`, {}),
  platformSettingHistory: (key: string): Promise<{ items: PlatformSettingChange[] }> =>
    getJson(`/v1/platform/settings/${encodeURIComponent(key)}/history`),
  upstreamModels: (): Promise<UpstreamModelList> => getJson('/v1/platform/models/upstream'),
  platformModels: (): Promise<{ items: RegisteredModelView[] }> => getJson('/v1/platform/models'),
  savePlatformModel: (body: {
    provider: string;
    modelId: string;
    metadata?: { source: string; provider: string; modelId: string } | null;
    sort?: number;
    active?: boolean;
  }): Promise<{ ok: boolean; id: string }> => postJson('/v1/platform/models', body),
  /** Update by id: provider/modelId are editable, so matching on them would insert a new row. */
  updatePlatformModel: (
    id: string,
    body: { provider: string; modelId: string; metadata?: { source: string; provider: string; modelId: string } | null; sort?: number; active?: boolean },
  ): Promise<{ ok: boolean; id: string }> => putJson(`/v1/platform/models/${encodeURIComponent(id)}`, body),
  /** Stages using the model are detached; `detachedFrom` lists them (`plan/stage`). */
  deletePlatformModel: (id: string): Promise<{ ok: boolean; detachedFrom: string[] }> =>
    delJson(`/v1/platform/models/${encodeURIComponent(id)}`, {}),
  /** Requires a query: the catalog is too large to send whole, and an empty query returns an empty list. */
  modelCatalog: (q: string): Promise<{ total: number; items: CatalogEntryView[] }> =>
    getJson(`/v1/platform/model-catalog?q=${encodeURIComponent(q)}`),
  /** Replaces the whole source; returns deleted/repriced counts. */
  syncModelCatalog: (): Promise<{ total: number; removed: number; repriced: { provider: string; modelId: string }[] }> =>
    postJson('/v1/platform/model-catalog/sync', {}),
  /** Full reorder written in one transaction. */
  reorderPlatformModels: (ids: string[]): Promise<{ ok: boolean }> =>
    postJson('/v1/platform/models/reorder', { ids }),
  /** Empty stage = that plan's default model. */
  planStageModels: (planKey: string): Promise<{ strategies: string[]; items: { stage: string; strategy: string; modelIds: string[] }[] }> =>
    getJson(`/v1/platform/plans/${encodeURIComponent(planKey)}/stage-models`),
  savePlanStageModels: (planKey: string, stage: string, body: { modelIds: string[]; strategy: string }): Promise<{ ok: boolean }> =>
    putJson(`/v1/platform/plans/${encodeURIComponent(planKey)}/stage-models/${encodeURIComponent(stage)}`, body),
  platformPlans: (): Promise<{ items: PlatformPlanView[] }> => getJson('/v1/platform/plans'),
  savePlatformPlan: (
    key: string,
    body: {
      name: string;
      modelTier?: string;
      monthlyCostCapUsd?: number | null;
      monthlyReviewQuota?: number | null;
      monthlyTokenQuota?: number | null;
      maxConcurrency?: number;
      active?: boolean;
    },
  ): Promise<{ ok: boolean }> => putJson(`/v1/platform/plans/${encodeURIComponent(key)}`, body),
  dashboard: (): Promise<DashboardSummary> => getJson('/v1/dashboard'),
  relationships: (): Promise<RelationshipRow[]> => getJson('/v1/repository-relationships'),
  createRelationship: (body: { sourceRepositoryId: string; targetRepositoryId: string; kind: string; instructions?: string }): Promise<{ ok: boolean; id: string }> =>
    postJson('/v1/repository-relationships', body),
  toggleRelationship: (id: string, enabled: boolean): Promise<{ ok: boolean }> => postJson(`/v1/repository-relationships/${id}/toggle`, { enabled }),
  transitionRelationship: (id: string, action: 'approve' | 'reject'): Promise<{ ok: boolean; status: string }> =>
    postJson(`/v1/repository-relationships/${id}/${action}`, {}),
  discoverRelationships: (): Promise<{ ok: boolean; jobId: string }> => postJson('/v1/repository-relationships/discover', {}),
  reviews: (p: ListArgs = {}): Promise<Paged<ReviewRun>> => getJson(`/v1/reviews${qs(p)}`),
  review: (revisionId: string): Promise<ReviewDetail> => getJson(`/v1/reviews/${revisionId}`),
  reviewProgress: (all = false): Promise<{ items: ReviewProgressItem[] }> => getJson(`/v1/reviews/progress${all ? '?all=1' : ''}`),
  /** Cooperative cancel: stops at the next cost boundary, publishes nothing, and bills what was spent. */
  cancelReviewProgress: (jobId: string): Promise<{ ok: boolean }> => postJson(`/v1/reviews/progress/${jobId}/cancel`, {}),
  installations: (p: ListArgs = {}): Promise<Paged<Installation>> => getJson(`/v1/installations${qs(p)}`),
  repositories: (p: ListArgs = {}): Promise<Paged<Repository>> => getJson(`/v1/repositories${qs(p)}`),
  audit: (p: ListArgs = {}): Promise<Paged<AuditEntry>> => getJson(`/v1/audit${qs(p)}`),
  auditFacets: (): Promise<{ actions: string[]; actors: { id: string; label: string | null }[] }> => getJson('/v1/audit/facets'),
  notifications: (p: { limit?: number; offset?: number; unread?: boolean } = {}): Promise<{ items: NotificationItem[]; total: number; unread: number }> =>
    getJson(`/v1/notifications${qs({ ...p, unread: p.unread ? '1' : undefined })}`),
  markNotificationRead: (id: string): Promise<{ ok: boolean }> => postJson(`/v1/notifications/${id}/read`, {}),
  markAllNotificationsRead: (): Promise<{ ok: boolean; updated: number }> => postJson('/v1/notifications/read-all', {}),
  repositoryConfig: (repositoryId: string): Promise<RepositoryConfig> => getJson(`/v1/repositories/${repositoryId}/config`),
  saveRepositoryConfig: (repositoryId: string, config: unknown): Promise<{ ok: boolean; digest: string }> =>
    putJson(`/v1/repositories/${repositoryId}/config`, config),
  previewRepositoryConfig: (repositoryId: string, config: unknown): Promise<ConfigPreview> =>
    postJson(`/v1/repositories/${repositoryId}/config/preview`, config),
  organizationConfig: (): Promise<{ settings: Record<string, unknown> }> => getJson('/v1/organization-config'),
  saveOrganizationConfig: (config: unknown): Promise<{ ok: boolean }> => putJson('/v1/organization-config', config),
  findings: (p: ListArgs = {}): Promise<Paged<FindingRow>> => getJson(`/v1/findings${qs(p)}`),
  finding: (findingId: string, revisionId?: string): Promise<FindingDetail> =>
    getJson(`/v1/findings/${findingId}${revisionId ? `?revisionId=${revisionId}` : ''}`),
  dismissFinding: (findingId: string, body: { changeRequestId: string; reason: string; proposeRule: boolean }): Promise<{ ok: boolean; ruleId?: string }> =>
    postJson(`/v1/findings/${findingId}/dismiss`, body),
  undismissFinding: (findingId: string, changeRequestId: string): Promise<{ ok: boolean }> =>
    postJson(`/v1/findings/${findingId}/undismiss`, { changeRequestId }),
  requestFix: (findingId: string, changeRequestId: string): Promise<{ planId: string }> =>
    postJson(`/v1/findings/${findingId}/fix`, { changeRequestId }),
  suppressed: (p: ListArgs = {}): Promise<Paged<SuppressedRow>> => getJson(`/v1/suppressed${qs(p)}`),
  runners: (p: ListArgs = {}): Promise<RunnersView> => getJson(`/v1/runners${qs(p)}`),
  actionPlans: (): Promise<ActionPlanRow[]> => getJson('/v1/action-plans'),
  /** Approve a proposed plan as the signed-in user (must be the one who asked for it, with action:approve). */
  confirmActionPlan: (id: string, conversationId: string): Promise<{ status: string }> =>
    postJson(`/v1/action-plans/${encodeURIComponent(id)}/confirm`, { conversationId }),
  declineActionPlan: (id: string): Promise<{ status: string }> => postJson(`/v1/action-plans/${id}/decline`, {}),
  inbox: (view: 'pending' | 'done' = 'pending'): Promise<{ items: InboxItem[] }> => getJson(`/v1/inbox?view=${view}`),
  inboxCount: (): Promise<{ pending: number }> => getJson('/v1/inbox/count'),
  actionPlanCommands: (id: string): Promise<{ commands: AgentCommandRow[] }> =>
    getJson(`/v1/action-plans/${encodeURIComponent(id)}/commands`),
  proposeLearning: (body: unknown): Promise<{ id: string; status: string }> => postJson('/v1/learnings', body),
  rules: (p: ListArgs & { scope?: string; state?: string } = {}): Promise<Paged<RuleRow> & { counts: Record<'all' | RuleScope, number> }> =>
    getJson(`/v1/rules${qs(p)}`),
  learningAction: (id: string, action: 'approve' | 'reject' | 'revoke'): Promise<{ status: string }> =>
    postJson(`/v1/learnings/${id}/${action}`, {}),
  memoryAction: (id: string, action: 'approve' | 'reject'): Promise<{ status: string }> =>
    postJson(`/v1/memories/${id}/${action}`, {}),
  globalLearnings: (p: ListArgs = {}): Promise<Paged<GlobalLearningRow>> => getJson(`/v1/global-learnings${qs(p)}`),
  globalLearning: (id: string): Promise<GlobalLearningRow> => getJson(`/v1/global-learnings/${id}`),
  proposeGlobalLearning: (body: unknown): Promise<GlobalLearningRow> => postJson('/v1/global-learnings', body),
  globalLearningAction: (id: string, action: 'approve' | 'reject' | 'revoke'): Promise<{ status: string }> =>
    postJson(`/v1/global-learnings/${id}/${action}`, {}),
  adoptGlobalLearning: (id: string, body: { scope: 'org' | 'repo'; repositoryIds?: string[] } = { scope: 'org' }): Promise<{ status: string }> =>
    postJson(`/v1/global-learnings/${id}/adopt`, body),
  declineGlobalLearning: (id: string): Promise<{ status: string }> => postJson(`/v1/global-learnings/${id}/decline`, {}),
  globalLearningsPolicy: (): Promise<{ policy: GlobalLearningsPolicy }> => getJson('/v1/global-learnings-policy'),
  ecosystemFacts: (p: ListArgs = {}): Promise<Paged<EcosystemFactRow>> => getJson(`/v1/ecosystem-facts${qs(p)}`),
  addEcosystemFact: (body: unknown): Promise<EcosystemFactRow> => postJson('/v1/ecosystem-facts', body),
  factFeeds: (): Promise<{ items: FactFeedRow[] }> => getJson('/v1/ecosystem-fact-feeds'),
  addFactFeed: (body: { ecosystem: string; subject: string; url: string; label?: string }): Promise<FactFeedRow> =>
    postJson('/v1/ecosystem-fact-feeds', body),
  factFeedAction: (id: string, action: 'enable' | 'disable' | 'refresh'): Promise<{ ok: boolean }> =>
    postJson(`/v1/ecosystem-fact-feeds/${id}/${action}`, {}),
  deleteFactFeed: (id: string): Promise<{ ok: boolean }> => delJson(`/v1/ecosystem-fact-feeds/${id}`, undefined),
  ecosystemFactAction: (id: string, action: 'approve' | 'reject', body: unknown = {}): Promise<EcosystemFactRow> =>
    postJson(`/v1/ecosystem-facts/${id}/${action}`, body),
  saveGlobalLearningsPolicy: (policy: GlobalLearningsPolicy): Promise<{ policy: GlobalLearningsPolicy }> =>
    putJson('/v1/global-learnings-policy', { policy }),
  conversations: (p: ListArgs = {}): Promise<Paged<ConversationRow>> => getJson(`/v1/conversations${qs(p)}`),
  usage: (since?: string): Promise<UsageSummary> => getJson(`/v1/usage${qs({ since })}`),
  setOveragePolicy: (action: string): Promise<{ ok: boolean }> => putJson('/v1/subscription/overage-policy', { action }),
  plugins: (): Promise<{ plugins: PluginInfo[] }> => getJson('/v1/plugins'),
  tenantSettings: (): Promise<{ settings: TenantPluginSettings }> => getJson('/v1/tenant-settings'),
  saveTenantSettings: (plugins: Record<string, { enabled: boolean }>): Promise<{ settings: TenantPluginSettings }> =>
    putJson('/v1/tenant-settings', { plugins }),
  serviceCredentials: (): Promise<{ credentials: ServiceCredentialMeta[] }> => getJson('/v1/service-credentials'),
  saveServiceCredential: (body: { service: string; apiKey: string; repositoryId?: string }): Promise<void> =>
    putJson('/v1/service-credentials', body),
  deleteServiceCredential: (body: { service: string; repositoryId?: string }): Promise<void> =>
    delJson('/v1/service-credentials', body),
  byok: (repositoryId?: string): Promise<ByokView> =>
    getJson(`/v1/byok${repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : ''}`),
  saveByok: (body: ByokInput & { repositoryId?: string }): Promise<void> => putJson('/v1/byok', body),
  deleteByok: (body: { repositoryId?: string }): Promise<void> => delJson('/v1/byok', body),
  byokModels: (body: { provider: string; apiKey?: string; repositoryId?: string }): Promise<{ models: ByokModelOption[] }> =>
    postJson('/v1/byok/models', body),
  // Account-level BYOK: only used on reviews the user started.
  myByok: (): Promise<ByokView> => getJson('/v1/my/byok'),
  saveMyByok: (body: ByokInput): Promise<void> => putJson('/v1/my/byok', body),
  deleteMyByok: (): Promise<void> => delJson('/v1/my/byok', {}),
  myByokModels: (body: { provider: string; apiKey?: string }): Promise<{ models: ByokModelOption[] }> => postJson('/v1/my/byok/models', body),
  myServiceCredentials: (): Promise<{ credentials: ServiceCredentialMeta[] }> => getJson('/v1/my/service-credentials'),
  saveMyServiceCredential: (body: { service: string; apiKey: string }): Promise<void> => putJson('/v1/my/service-credentials', body),
  deleteMyServiceCredential: (service: string): Promise<void> => delJson('/v1/my/service-credentials', { service }),
};
