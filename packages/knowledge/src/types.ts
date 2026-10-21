export type KnowledgeCategory =
  | 'authoritative-rule'
  | 'approved-learning'
  | 'historical-evidence'
  | 'external-context'
  | 'ephemeral-conversation';

/** AGENTS.md / CLAUDE.md are not rules: they enter the prompt as repo data (see repo-guidance.ts). */
export type AuthoritativeSourceKind =
  | 'reviewbot-yaml'
  | 'contributing'
  | 'readme-docs'
  | 'lint-build-config'
  | 'org-policy'
  | 'path-ast-instruction'
  | 'approved-external-docs';

export interface AuthoritativeRule {
  id: string;
  instruction: string;
  source: AuthoritativeSourceKind;
  /** Higher wins; determined by source. */
  priority: number;
  /** Path glob / symbol; absent = repo-wide. */
  selector?: string;
}

export interface CommentRef {
  nativeId: string;
  url?: string;
}

export type LearningStatus = 'proposed' | 'approved' | 'rejected' | 'revoked' | 'expired';

/** Who it applies to, who approves it, and where it is stored. */
export type LearningBroadness = 'global' | 'organization' | 'repository' | 'user';
/** Where in the code it applies; `selector` holds the glob/symbol. */
export type LearningLocality = 'none' | 'path' | 'symbol';
/** default = more specific items may override; mandatory = platform/org policy that cannot be overridden. */
export type LearningEnforcement = 'default' | 'mandatory';

export interface LearningProposal {
  id: string;
  /** null for org/user/global broadness. */
  repositoryId: string | null;
  broadness: LearningBroadness;
  locality: LearningLocality;
  selector?: string;
  /** user broadness: target provider identity (not written yet). */
  subjectRef?: string;
  enforcement: LearningEnforcement;
  instruction: string;
  rationale: string;
  sourceCommentRef?: CommentRef;
  /** Actor ref or 'agent'. */
  proposedBy: string;
  status: LearningStatus;
  approvedBy?: string;
  /** Epoch ms. */
  approvedAt?: number;
  expiresAt?: number;
  version: number;
  /** Times selected/injected by a review (incremented by markLearningsUsed). */
  usageCount?: number;
  /** Epoch ms. */
  lastUsedAt?: number;
  /** Epoch ms; set when read from the store. */
  createdAt?: number;
}

/** One model's vote on a candidate global learning. */
export interface PanelVote {
  model: string;
  decision: 'approve' | 'reject';
  /** 0-1. */
  confidence: number;
  reasoning: string;
}

/** Multi-model deliberation record: evidence, per-model votes, aggregate and system usage. */
export interface GlobalLearningDeliberation {
  signal?: { kind: 'design' | 'cve' | 'pitfall' | string; note: string };
  evidence: string[];
  draftModel: string;
  panel: PanelVote[];
  aggregate: { confidence: number; approvals: number; total: number };
  /** System cost, not counted against tenant quota. */
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

/**
 * Structured origin of an auto-proposed global learning. Operator-only: strip from every
 * tenant-visible projection. Manual proposals have none.
 */
export interface GlobalLearningSource {
  triggerTenantId: string;
  triggerRevisionId: string;
  /** Cross-tenant recurrence count in the draft evidence. */
  evidenceTenantCount?: number;
}

/** prompt = confirm each in the inbox; auto_accept = no row counts as adopted; ignore = never inject or prompt. */
export type GlobalLearningsPolicy = 'prompt' | 'auto_accept' | 'ignore';

/** A tenant's adoption decision; pending has no row. */
export interface GlobalLearningAdoption {
  id: string;
  globalLearningId: string;
  status: 'accepted' | 'declined';
  scope: 'org' | 'repo';
  /** Repository ids when scope=repo. */
  repositoryIds?: string[];
  decidedBy: string;
  /** Epoch ms. */
  decidedAt: number;
}

/**
 * Operator-curated global learning. `default` ones take effect once a tenant adopts them;
 * `mandatory` ones always apply. No tenant/repository; locality is none|path only.
 */
export interface GlobalLearning {
  id: string;
  locality: 'none' | 'path';
  selector?: string;
  instruction: string;
  rationale: string;
  enforcement: LearningEnforcement;
  status: LearningStatus;
  /** platform-operator OIDC sub; 'system' for auto proposals. */
  proposedBy: string;
  approvedBy?: string;
  version: number;
  origin: 'operator' | 'auto';
  /** 0-1 aggregate confidence (auto only). */
  confidence?: number;
  /** Auto only; operator-only. */
  deliberation?: GlobalLearningDeliberation;
  /** Auto only; operator-only, stripped from tenant projections. */
  source?: GlobalLearningSource;
  /** Epoch ms; expiry is applied at read time. */
  expiresAt?: number;
}

export type MemoryKind = 'repo-quirk' | 'false-positive-pattern' | 'reviewer-pref' | 'arch-note';

export const MEMORY_KINDS: readonly MemoryKind[] = ['repo-quirk', 'false-positive-pattern', 'reviewer-pref', 'arch-note'];

export type AgentMemoryStatus = 'active' | 'archived' | 'proposed' | 'rejected';

export interface MemorySourceComment {
  /** Native id of the comment's thread target. */
  targetNativeId: string;
  commentNativeId?: string;
  actorLogin: string;
}

/**
 * Agent-curated repo working memory, a soft reference: the summary is indexed, the body loaded lazily.
 * Memories from reviews and from maintainers apply at once; ones from outside commenters are `proposed`.
 */
export interface AgentMemory {
  id: string;
  kind: MemoryKind;
  /** Normalised dedup key within the repo. */
  title: string;
  /** Index line, used as the recall key. */
  summary: string;
  body: string;
  /** Path glob; absent = applies repo-wide. */
  selector?: string;
  /** Linked memory ids. */
  links: string[];
  /** Originating revision id. */
  originReviewId?: string;
  status: AgentMemoryStatus;
  /** Forge login of the commenter a conversation memory came from. */
  proposedBy?: string;
  sourceCommentRef?: MemorySourceComment;
  /** Epoch ms. */
  expiresAt?: number;
  version: number;
}

export type FeedbackClass =
  | 'fixed'
  | 'accepted'
  | 'false-positive'
  | 'not-important'
  | 'duplicate'
  | 'already-known'
  | 'wrong-location'
  | 'wrong-severity'
  | 'bad-suggestion';

export const FEEDBACK_CLASSES: readonly FeedbackClass[] = [
  'fixed',
  'accepted',
  'false-positive',
  'not-important',
  'duplicate',
  'already-known',
  'wrong-location',
  'wrong-severity',
  'bad-suggestion',
];

/** Retrieval categories, in priority order. */
export type RetrievalCategory =
  | 'authoritative-rule'
  | 'approved-learning'
  | 'agent-memory'
  | 'exact-prior-finding'
  | 'related-pr-issue'
  | 'semantic-historical'
  | 'external-context';

export interface RetrievalItem {
  id: string;
  category: RetrievalCategory;
  content: string;
  /** Path glob; absent = applies everywhere. */
  selector?: string;
  /** Epoch ms; absent = never expires. */
  expiresAt?: number;
  /** Higher = more specific and preferred (global<org<repo<user; within a broadness none<path<symbol). */
  specificity?: number;
  /** Not overridden by more specific items; pinned first within its category. */
  mandatory?: boolean;
}
