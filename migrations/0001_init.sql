-- Schema baseline (pg_dump --schema-only --no-owner --no-privileges) plus seeded `plans` rows.
-- Roles and grants are deployment-specific (DB_APP_USER); RLS only applies to the non-owner app role.


CREATE TABLE public.action_plans (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    actor_id text NOT NULL,
    revision_sha text,
    actions jsonb NOT NULL,
    required_permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    execution_token uuid,
    execution_expires_at timestamp with time zone,
    approval_actor text,
    dedupe_key text,
    approved_by_actor_id text,
    CONSTRAINT action_plans_approval_actor_chk CHECK (((approval_actor IS NULL) OR (approval_actor = 'any-authorized'::text))),
    CONSTRAINT action_plans_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'executing'::text, 'rejected'::text, 'executed'::text, 'expired'::text])))
);

ALTER TABLE ONLY public.action_plans FORCE ROW LEVEL SECURITY;

CREATE TABLE public.agent_memories (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    body text NOT NULL,
    selector text,
    links jsonb DEFAULT '[]'::jsonb NOT NULL,
    origin_review_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_memory_kind_ck CHECK ((kind = ANY (ARRAY['repo-quirk'::text, 'false-positive-pattern'::text, 'reviewer-pref'::text, 'arch-note'::text]))),
    CONSTRAINT agent_memory_status_ck CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.agent_memories FORCE ROW LEVEL SECURITY;

CREATE TABLE public.artifacts (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    storage_key text NOT NULL,
    content_type text,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    encrypted boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.artifacts FORCE ROW LEVEL SECURITY;

CREATE TABLE public.audit_events (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    actor text,
    action text NOT NULL,
    target text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.audit_events FORCE ROW LEVEL SECURITY;

CREATE TABLE public.change_requests (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    native_id text NOT NULL,
    number integer NOT NULL,
    kind text NOT NULL,
    source_branch text,
    target_branch text,
    state text DEFAULT 'open'::text NOT NULL,
    draft boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    author text,
    author_provider_id text,
    reviewers jsonb DEFAULT '[]'::jsonb NOT NULL,
    labels jsonb DEFAULT '[]'::jsonb NOT NULL,
    auto_review_paused boolean DEFAULT false NOT NULL,
    stacked_on_change_request_id uuid,
    stack_base_ref text,
    stack_position integer,
    stack_size integer,
    author_is_bot boolean,
    last_provider_event_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.change_requests FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.change_requests.auto_review_paused IS '本 CR 是否暂停自动 review(§26.4 @bot pause/resume)。仅挡 auto 触发;manual(@bot review)恒绕过且不解除。';

COMMENT ON COLUMN public.change_requests.stacked_on_change_request_id IS '§26.7:本 CR stack 在哪个 CR 之上(base 分支 = 该 CR 的源分支);非 stacked 为 null。';

COMMENT ON COLUMN public.change_requests.stack_base_ref IS '§26.7:整条 stack 的最终目标分支(GitHub 原生 stack.base.ref);判 reviews.auto.base_branches 用。provider 未提供则 null,回退拓扑推断。';

COMMENT ON COLUMN public.change_requests.author_is_bot IS 'Whether the pull request author was a bot, as reported by the forge at open time. Null = unknown (row predates the column, or the forge did not say).';

CREATE TABLE public.conversation_messages (
    id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    actor_login text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.conversations (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_native_id text NOT NULL,
    state text NOT NULL,
    context_revision_sha text,
    summary text DEFAULT ''::text NOT NULL,
    active_task_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    repository_id uuid,
    change_request_id uuid
);

ALTER TABLE ONLY public.conversations FORCE ROW LEVEL SECURITY;

CREATE TABLE public.cross_tenant_events (
    id uuid NOT NULL,
    relationship_id uuid NOT NULL,
    source_tenant_id uuid NOT NULL,
    source_repository_id uuid NOT NULL,
    target_tenant_id uuid NOT NULL,
    target_repository_id uuid NOT NULL,
    kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.cross_tenant_events FORCE ROW LEVEL SECURITY;

CREATE TABLE public.cross_tenant_relationships (
    id uuid NOT NULL,
    source_tenant_id uuid NOT NULL,
    source_repository_id uuid NOT NULL,
    target_tenant_id uuid NOT NULL,
    target_repository_id uuid NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    proposed_by text,
    decided_by text,
    rationale text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cross_tenant_distinct CHECK ((source_tenant_id <> target_tenant_id))
);

ALTER TABLE ONLY public.cross_tenant_relationships FORCE ROW LEVEL SECURITY;

CREATE TABLE public.domain_events (
    id uuid NOT NULL,
    tenant_id uuid,
    provider_event_id uuid NOT NULL,
    type text NOT NULL,
    repository_id uuid,
    change_request_id uuid,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.domain_events FORCE ROW LEVEL SECURITY;

CREATE TABLE public.ecosystem_facts (
    id uuid NOT NULL,
    ecosystem text NOT NULL,
    subject text NOT NULL,
    versions text,
    claim text NOT NULL,
    detail text,
    sources jsonb NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    origin text NOT NULL,
    proposed_from jsonb,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    reviewed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ecosystem_facts_origin_ck CHECK ((origin = ANY (ARRAY['review'::text, 'operator'::text]))),
    CONSTRAINT ecosystem_facts_status_ck CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'rejected'::text])))
);

CREATE TABLE public.feedbacks (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid,
    fingerprint text,
    finding_id uuid,
    class text NOT NULL,
    actor text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.finding_dismissals (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    finding_id uuid NOT NULL,
    change_request_id uuid NOT NULL,
    actor text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    weak_fingerprint text
);

ALTER TABLE ONLY public.finding_dismissals FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.finding_dismissals IS '§26.4:某条 finding 在某个 CR 上被用户忽略(PR 级,非仓库级)。撤销 = 删行(@bot unignore)。';

COMMENT ON COLUMN public.finding_dismissals.weak_fingerprint IS '§26.4:不含 claim 措辞的弱指纹(repo+category+codeWindow),用于跨轮匹配被忽略的问题;历史行为 NULL(仅强指纹匹配)。';

CREATE TABLE public.finding_occurrences (
    id uuid NOT NULL,
    finding_id uuid NOT NULL,
    review_run_id uuid,
    revision_id uuid NOT NULL,
    state text NOT NULL,
    severity text NOT NULL,
    change_relation text NOT NULL,
    confirmation text NOT NULL,
    anchor jsonb,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    anchor_text text,
    blocking boolean DEFAULT false NOT NULL,
    tenant_id uuid NOT NULL,
    demotions jsonb DEFAULT '[]'::jsonb NOT NULL,
    effort text,
    refuter_upheld boolean,
    claim text,
    rationale text,
    CONSTRAINT finding_occurrences_effort_check CHECK (((effort IS NULL) OR (effort = ANY (ARRAY['quick-win'::text, 'heavy-lift'::text]))))
);

ALTER TABLE ONLY public.finding_occurrences FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.finding_occurrences.demotions IS 'Ordered demotion reasons that moved this finding out of inline placement (§21.1); empty when it was never on the inline track.';

CREATE TABLE public.findings (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    semantic_fingerprint text NOT NULL,
    category text NOT NULL,
    canonical_claim text NOT NULL,
    lifecycle text NOT NULL,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL
);

ALTER TABLE ONLY public.findings FORCE ROW LEVEL SECURITY;

CREATE TABLE public.global_learning_adoptions (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    global_learning_id uuid NOT NULL,
    status text NOT NULL,
    scope text DEFAULT 'org'::text NOT NULL,
    repository_ids jsonb,
    decided_by text NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gl_adoption_scope_ck CHECK ((scope = ANY (ARRAY['org'::text, 'repo'::text]))),
    CONSTRAINT gl_adoption_status_ck CHECK ((status = ANY (ARRAY['accepted'::text, 'declined'::text])))
);

ALTER TABLE ONLY public.global_learning_adoptions FORCE ROW LEVEL SECURITY;

CREATE TABLE public.global_learnings (
    id uuid NOT NULL,
    locality text DEFAULT 'none'::text NOT NULL,
    selector text,
    instruction text NOT NULL,
    rationale text NOT NULL,
    enforcement text DEFAULT 'default'::text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    proposed_by text NOT NULL,
    approved_by text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT 'operator'::text NOT NULL,
    confidence numeric(4,3),
    deliberation jsonb,
    source jsonb,
    CONSTRAINT global_locality_ck CHECK ((locality = ANY (ARRAY['none'::text, 'path'::text])))
);

CREATE TABLE public.installations (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    provider_host_id uuid NOT NULL,
    native_id text NOT NULL,
    account_login text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.installations FORCE ROW LEVEL SECURITY;

CREATE TABLE public.job_attempts (
    id uuid NOT NULL,
    job_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    worker_id uuid,
    status text NOT NULL,
    error jsonb,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone
);

CREATE TABLE public.jobs (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    dedupe_key text,
    payload jsonb NOT NULL,
    runner_selector jsonb DEFAULT '{}'::jsonb NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner uuid,
    lease_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    cancellation_requested boolean DEFAULT false NOT NULL,
    superseded_by uuid,
    last_error jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    trace_context jsonb
);

ALTER TABLE ONLY public.jobs FORCE ROW LEVEL SECURITY;

CREATE TABLE public.learning_proposals (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid,
    selector text,
    instruction text NOT NULL,
    rationale text NOT NULL,
    source_comment_ref jsonb,
    proposed_by text NOT NULL,
    status text NOT NULL,
    approved_by text,
    approved_at timestamp with time zone,
    expires_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    broadness text DEFAULT 'repository'::text NOT NULL,
    locality text DEFAULT 'none'::text NOT NULL,
    subject_ref text,
    enforcement text DEFAULT 'default'::text NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    CONSTRAINT learning_scope_consistency CHECK ((((broadness = 'repository'::text) AND (repository_id IS NOT NULL)) OR ((broadness = 'organization'::text) AND (repository_id IS NULL)) OR ((broadness = 'user'::text) AND (repository_id IS NULL) AND (subject_ref IS NOT NULL))))
);

ALTER TABLE ONLY public.learning_proposals FORCE ROW LEVEL SECURITY;

CREATE TABLE public.login_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    issuer text NOT NULL,
    label text NOT NULL,
    client_id text NOT NULL,
    secret_envelope jsonb NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.memberships (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL
);

ALTER TABLE ONLY public.memberships FORCE ROW LEVEL SECURITY;

CREATE TABLE public.model_catalog (
    source text NOT NULL,
    provider text NOT NULL,
    model_id text NOT NULL,
    name text NOT NULL,
    context_window integer NOT NULL,
    max_tokens integer NOT NULL,
    reasoning boolean NOT NULL,
    input text NOT NULL,
    cost jsonb NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.model_catalog IS 'Model specs synced from an external catalog (models.dev). Referenced by models.metadata_*.';

CREATE TABLE public.models (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    model_id text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    sort integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata_source text,
    metadata_provider text,
    metadata_model_id text
);

CREATE TABLE public.notifications (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    link text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    read_at timestamp with time zone,
    emailed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    email_claim_token uuid,
    email_claim_expires_at timestamp with time zone,
    CONSTRAINT notifications_email_claim_complete_chk CHECK (((email_claim_token IS NULL) = (email_claim_expires_at IS NULL)))
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;

CREATE TABLE public.pending_installations (
    id uuid NOT NULL,
    provider text NOT NULL,
    installation_native_id text NOT NULL,
    account_login text NOT NULL,
    installer_provider_user_id text NOT NULL,
    installer_login text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_by text,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.plan_stage_models (
    plan_id uuid NOT NULL,
    stage text NOT NULL,
    model_id uuid NOT NULL,
    sort integer DEFAULT 100 NOT NULL
);

COMMENT ON TABLE public.plan_stage_models IS 'Ordered per-stage model list for one plan. Empty for a stage = that stage uses the plan default model.';

CREATE TABLE public.plan_stage_policies (
    plan_id uuid NOT NULL,
    stage text NOT NULL,
    strategy text DEFAULT 'fill-first'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);

COMMENT ON TABLE public.plan_stage_policies IS 'How one plan picks among a stage''s models. Absent row = fill-first, the pre-0067 behaviour.';

CREATE TABLE public.plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    model_tier text NOT NULL,
    monthly_review_quota integer,
    monthly_token_quota bigint,
    max_concurrency integer DEFAULT 4 NOT NULL,
    features jsonb DEFAULT '{}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    monthly_cost_cap_usd numeric(12,4),
    daily_cost_cap_usd numeric(12,4),
    review_cost_cap_usd numeric(12,4)
);

COMMENT ON COLUMN public.plans.monthly_review_quota IS '滥用闸(非成本手段):防止用超便宜模型刷次数压垮系统。成本请用 monthly_cost_cap_usd。';

COMMENT ON COLUMN public.plans.daily_cost_cap_usd IS '单日成本熔断上限(USD)。NULL=继承 env DAILY_COST_CAP_USD;0=显式不限;>0=用此值。';

COMMENT ON COLUMN public.plans.review_cost_cap_usd IS '单次 review 成本上限(USD)。NULL=继承 env REVIEW_COST_CAP_USD;0=显式不限;>0=用此值。';

CREATE TABLE public.platform_settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);

CREATE TABLE public.pr_coverage (
    tenant_id uuid NOT NULL,
    change_request_id uuid NOT NULL,
    path text NOT NULL,
    covered_at_sha text NOT NULL,
    covered_at timestamp with time zone DEFAULT now() NOT NULL,
    material_digest text,
    review_contract_digest text,
    dependencies jsonb DEFAULT '[]'::jsonb NOT NULL,
    note text
);

ALTER TABLE ONLY public.pr_coverage FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pr_coverage IS 'Which changed files of a pull request have been explored, and at which head. Records that a path was looked at, never what was concluded there.';

COMMENT ON COLUMN public.pr_coverage.material_digest IS 'SHA-256 of versioned per-file PR material. NULL means equality cannot be proven and the file must be reviewed again.';

COMMENT ON COLUMN public.pr_coverage.review_contract_digest IS 'SHA-256 of the effective review configuration and prompts. NULL legacy rows are never reused.';

CREATE TABLE public.provider_credentials (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    provider_host_id uuid NOT NULL,
    kind text NOT NULL,
    envelope jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.provider_credentials FORCE ROW LEVEL SECURITY;

CREATE TABLE public.provider_events (
    id uuid NOT NULL,
    tenant_id uuid,
    provider text NOT NULL,
    provider_host_id uuid,
    installation_id uuid,
    delivery_id text,
    event_type text NOT NULL,
    dedupe_key text NOT NULL,
    signature_valid boolean NOT NULL,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    body text NOT NULL,
    received_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.provider_events FORCE ROW LEVEL SECURITY;

CREATE TABLE public.provider_hosts (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    provider text NOT NULL,
    base_url text NOT NULL,
    api_url text NOT NULL,
    is_saas boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.provider_hosts FORCE ROW LEVEL SECURITY;

CREATE TABLE public.publication_records (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid,
    change_request_id uuid,
    finding_id uuid,
    revision_id uuid,
    provider_host_id uuid NOT NULL,
    kind text NOT NULL,
    idempotency_key text NOT NULL,
    provider_native_id text,
    provider_url text,
    state text NOT NULL,
    request_digest text NOT NULL,
    response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.publication_records FORCE ROW LEVEL SECURITY;

CREATE TABLE public.repositories (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    provider_host_id uuid NOT NULL,
    installation_id uuid NOT NULL,
    native_id text NOT NULL,
    namespace text NOT NULL,
    name text NOT NULL,
    clone_url text NOT NULL,
    default_branch text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    visibility text
);

ALTER TABLE ONLY public.repositories FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.repositories.visibility IS 'public | private; NULL = unknown, billed as private.';

CREATE TABLE public.repository_packages (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    role text NOT NULL,
    ecosystem text NOT NULL,
    name text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.repository_packages FORCE ROW LEVEL SECURITY;

CREATE TABLE public.repository_relationships (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    source_repository_id uuid NOT NULL,
    target_repository_id uuid NOT NULL,
    kind text NOT NULL,
    instructions text,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    proposed_by text,
    rationale text
);

ALTER TABLE ONLY public.repository_relationships FORCE ROW LEVEL SECURITY;

CREATE TABLE public.repository_settings (
    repository_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    config_digest text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'panel'::text NOT NULL,
    panel_settings jsonb,
    CONSTRAINT repository_settings_source_ck CHECK ((source = ANY (ARRAY['panel'::text, 'repo-file'::text])))
);

ALTER TABLE ONLY public.repository_settings FORCE ROW LEVEL SECURITY;

CREATE TABLE public.review_costs (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    change_request_id uuid,
    revision_id uuid NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    total_tokens bigint DEFAULT 0 NOT NULL,
    cost_usd numeric(12,6) DEFAULT 0 NOT NULL,
    candidate_count integer DEFAULT 0 NOT NULL,
    published_inline integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    scopes_total integer DEFAULT 0 NOT NULL,
    scopes_complete integer DEFAULT 0 NOT NULL,
    model_source text DEFAULT 'platform'::text NOT NULL,
    stage_usage jsonb,
    repo_visibility text,
    cancelled boolean DEFAULT false NOT NULL,
    stage_ms jsonb,
    CONSTRAINT review_costs_model_source_check CHECK ((model_source = ANY (ARRAY['platform'::text, 'byok'::text])))
);

ALTER TABLE ONLY public.review_costs FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.review_costs.stage_usage IS '§44:分阶段用量 {map,dig,synthesis,verify}→{inputTokens,outputTokens,totalTokens,costUsd};缺省段缺席。';

COMMENT ON COLUMN public.review_costs.repo_visibility IS 'Repository visibility at the time of the run. Snapshot: visibility changes must not re-price past usage.';

COMMENT ON COLUMN public.review_costs.cancelled IS '本行来自取消收工的 review:用量如实计费,但不算"这个 revision 已评审过"。';

COMMENT ON COLUMN public.review_costs.stage_ms IS '分阶段墙钟(ms){prepare,map,dig,synthesis,verifyTail,publish,total};缺省段缺席。';

CREATE TABLE public.review_progress (
    job_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    change_request_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    stage text NOT NULL,
    done integer,
    total integer,
    attempt integer DEFAULT 1 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);

ALTER TABLE ONLY public.review_progress FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.review_progress IS 'Live progress of a review job. One row per job: retries overwrite, they do not accumulate. Stage names here are internal; the console maps them to plain language for tenant users.';

CREATE TABLE public.revisions (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    change_request_id uuid NOT NULL,
    base_sha text NOT NULL,
    head_sha text NOT NULL,
    merge_base_sha text,
    source_branch text,
    target_branch text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE public.runner_pools (
    id uuid NOT NULL,
    tenant_id uuid,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.sandbox_vm_leases (
    id uuid NOT NULL,
    vm_name text NOT NULL,
    owner_worker_id uuid NOT NULL,
    sandbox_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.sandbox_vms (
    name text NOT NULL,
    status text NOT NULL,
    image text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ready_at timestamp with time zone,
    last_released_at timestamp with time zone,
    health_failures integer DEFAULT 0 NOT NULL,
    last_error text
);

CREATE TABLE public.service_credentials (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    repository_id uuid,
    user_id uuid,
    service text NOT NULL,
    envelope jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_credentials_one_scope CHECK (((repository_id IS NULL) OR (user_id IS NULL)))
);

ALTER TABLE ONLY public.service_credentials FORCE ROW LEVEL SECURITY;

CREATE TABLE public.subscriptions (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    overage_policy text DEFAULT 'reject'::text NOT NULL,
    current_period_start timestamp with time zone DEFAULT now() NOT NULL,
    current_period_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tenant_invites (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    token text NOT NULL,
    invited_by uuid,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tenants (
    id uuid NOT NULL,
    name text NOT NULL,
    region text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    global_learnings_policy text DEFAULT 'prompt'::text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT tenants_gl_policy_ck CHECK ((global_learnings_policy = ANY (ARRAY['prompt'::text, 'auto_accept'::text, 'ignore'::text])))
);

CREATE TABLE public.user_identities (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    login text,
    tenant_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    provider text
);

COMMENT ON COLUMN public.user_identities.issuer IS 'kind=oidc: JWT 的 iss;kind=provider: **forge 的 origin**(https://github.com / https://git.acme.com)。认人只按 (kind, issuer, subject),不按 login(可改名)、不按 email(自建实例可伪造)。';

COMMENT ON COLUMN public.user_identities.provider IS 'kind=provider 时的 forge 类型(github|gitlab|forgejo)。仅用于展示与按类型检索,**不参与认人**——认人靠 issuer(host)。';

CREATE TABLE public.users (
    id uuid NOT NULL,
    email text NOT NULL,
    display_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.workers (
    id uuid NOT NULL,
    pool_id uuid NOT NULL,
    mode text DEFAULT 'active'::text NOT NULL,
    version text NOT NULL,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    max_concurrency integer DEFAULT 1 NOT NULL,
    running_jobs integer DEFAULT 0 NOT NULL,
    last_heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.action_plans
    ADD CONSTRAINT action_plans_pkey PRIMARY KEY (id);

ALTER TABLE public.action_plans
    ADD CONSTRAINT action_plans_status_chk CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'executing'::text, 'rejected'::text, 'executed'::text, 'expired'::text]))) NOT VALID;

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memory_title_uq UNIQUE (tenant_id, repository_id, title);

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_storage_key_key UNIQUE (storage_key);

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.change_requests
    ADD CONSTRAINT change_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.change_requests
    ADD CONSTRAINT change_requests_repository_id_native_id_key UNIQUE (repository_id, native_id);

ALTER TABLE ONLY public.conversation_messages
    ADD CONSTRAINT conversation_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cross_tenant_events
    ADD CONSTRAINT cross_tenant_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cross_tenant_relationships
    ADD CONSTRAINT cross_tenant_relationships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cross_tenant_relationships
    ADD CONSTRAINT cross_tenant_relationships_source_repository_id_target_repo_key UNIQUE (source_repository_id, target_repository_id, kind);

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ecosystem_facts
    ADD CONSTRAINT ecosystem_facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedbacks
    ADD CONSTRAINT feedbacks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.finding_dismissals
    ADD CONSTRAINT finding_dismissals_finding_id_change_request_id_key UNIQUE (finding_id, change_request_id);

ALTER TABLE ONLY public.finding_dismissals
    ADD CONSTRAINT finding_dismissals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.finding_occurrences
    ADD CONSTRAINT finding_occurrences_finding_id_revision_id_key UNIQUE (finding_id, revision_id);

ALTER TABLE ONLY public.finding_occurrences
    ADD CONSTRAINT finding_occurrences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_repository_id_semantic_fingerprint_key UNIQUE (repository_id, semantic_fingerprint);

ALTER TABLE ONLY public.global_learning_adoptions
    ADD CONSTRAINT gl_adoption_uq UNIQUE (tenant_id, global_learning_id);

ALTER TABLE ONLY public.global_learning_adoptions
    ADD CONSTRAINT global_learning_adoptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.global_learnings
    ADD CONSTRAINT global_learnings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.installations
    ADD CONSTRAINT installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.installations
    ADD CONSTRAINT installations_provider_host_id_native_id_key UNIQUE (provider_host_id, native_id);

ALTER TABLE ONLY public.job_attempts
    ADD CONSTRAINT job_attempts_job_id_attempt_number_key UNIQUE (job_id, attempt_number);

ALTER TABLE ONLY public.job_attempts
    ADD CONSTRAINT job_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.learning_proposals
    ADD CONSTRAINT learning_proposals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.login_instances
    ADD CONSTRAINT login_instances_issuer_key UNIQUE (issuer);

ALTER TABLE ONLY public.login_instances
    ADD CONSTRAINT login_instances_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_tenant_id_user_id_key UNIQUE (tenant_id, user_id);

ALTER TABLE ONLY public.model_catalog
    ADD CONSTRAINT model_catalog_pkey PRIMARY KEY (source, provider, model_id);

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pending_installations
    ADD CONSTRAINT pending_installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pending_installations
    ADD CONSTRAINT pending_installations_provider_installation_native_id_key UNIQUE (provider, installation_native_id);

ALTER TABLE ONLY public.plan_stage_models
    ADD CONSTRAINT plan_stage_models_pkey PRIMARY KEY (plan_id, stage, model_id);

ALTER TABLE ONLY public.plan_stage_policies
    ADD CONSTRAINT plan_stage_policies_pkey PRIMARY KEY (plan_id, stage);

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_key_key UNIQUE (key);

ALTER TABLE ONLY public.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.pr_coverage
    ADD CONSTRAINT pr_coverage_pkey PRIMARY KEY (change_request_id, path);

ALTER TABLE ONLY public.provider_credentials
    ADD CONSTRAINT provider_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provider_credentials
    ADD CONSTRAINT provider_credentials_provider_host_id_kind_key UNIQUE (provider_host_id, kind);

ALTER TABLE ONLY public.provider_events
    ADD CONSTRAINT provider_events_dedupe_key_key UNIQUE (dedupe_key);

ALTER TABLE ONLY public.provider_events
    ADD CONSTRAINT provider_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.provider_hosts
    ADD CONSTRAINT provider_hosts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.publication_records
    ADD CONSTRAINT publication_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.publication_records
    ADD CONSTRAINT publication_records_provider_host_id_idempotency_key_key UNIQUE (provider_host_id, idempotency_key);

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_provider_host_id_native_id_key UNIQUE (provider_host_id, native_id);

ALTER TABLE ONLY public.repository_packages
    ADD CONSTRAINT repository_packages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.repository_packages
    ADD CONSTRAINT repository_packages_repository_id_role_ecosystem_name_key UNIQUE (repository_id, role, ecosystem, name);

ALTER TABLE ONLY public.repository_relationships
    ADD CONSTRAINT repository_relationships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.repository_relationships
    ADD CONSTRAINT repository_relationships_source_repository_id_target_reposi_key UNIQUE (source_repository_id, target_repository_id, kind);

ALTER TABLE ONLY public.repository_settings
    ADD CONSTRAINT repository_settings_pkey PRIMARY KEY (repository_id);

ALTER TABLE ONLY public.review_costs
    ADD CONSTRAINT review_costs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.review_costs
    ADD CONSTRAINT review_costs_revision_id_key UNIQUE (revision_id);

ALTER TABLE ONLY public.review_progress
    ADD CONSTRAINT review_progress_pkey PRIMARY KEY (job_id);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_change_request_id_head_sha_key UNIQUE (change_request_id, head_sha);

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.runner_pools
    ADD CONSTRAINT runner_pools_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sandbox_vm_leases
    ADD CONSTRAINT sandbox_vm_leases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sandbox_vms
    ADD CONSTRAINT sandbox_vms_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.service_credentials
    ADD CONSTRAINT service_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_tenant_id_key UNIQUE (tenant_id);

ALTER TABLE ONLY public.tenant_invites
    ADD CONSTRAINT tenant_invites_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tenant_invites
    ADD CONSTRAINT tenant_invites_token_key UNIQUE (token);

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_kind_issuer_subject_key UNIQUE (kind, issuer, subject);

ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_pkey PRIMARY KEY (id);

CREATE INDEX action_plans_conversation_idx ON public.action_plans USING btree (conversation_id);

CREATE UNIQUE INDEX action_plans_dedupe_key_uniq ON public.action_plans USING btree (tenant_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);

CREATE INDEX action_plans_execution_expiry_idx ON public.action_plans USING btree (execution_expires_at) WHERE (status = 'executing'::text);

CREATE INDEX action_plans_tenant_status_idx ON public.action_plans USING btree (tenant_id, status);

CREATE INDEX agent_memories_repo_idx ON public.agent_memories USING btree (tenant_id, repository_id, status);

CREATE INDEX artifacts_expiry_idx ON public.artifacts USING btree (expires_at) WHERE (expires_at IS NOT NULL);

CREATE INDEX artifacts_tenant_idx ON public.artifacts USING btree (tenant_id, created_at DESC);

CREATE INDEX audit_events_action_idx ON public.audit_events USING btree (action);

CREATE INDEX audit_events_tenant_idx ON public.audit_events USING btree (tenant_id, created_at DESC);

CREATE UNIQUE INDEX change_requests_repo_kind_number_uq ON public.change_requests USING btree (repository_id, kind, number);

CREATE INDEX change_requests_repo_number_idx ON public.change_requests USING btree (repository_id, number);

CREATE INDEX change_requests_stacked_on_idx ON public.change_requests USING btree (stacked_on_change_request_id);

CREATE UNIQUE INDEX change_requests_tenant_id_uq ON public.change_requests USING btree (tenant_id, id);

CREATE INDEX change_requests_tenant_idx ON public.change_requests USING btree (tenant_id);

CREATE INDEX conversation_messages_conv_idx ON public.conversation_messages USING btree (conversation_id, created_at);

CREATE INDEX conversations_change_request_idx ON public.conversations USING btree (change_request_id);

CREATE UNIQUE INDEX conversations_target_identity_uq ON public.conversations USING btree (tenant_id, target_kind, target_native_id, COALESCE((repository_id)::text, ''::text), COALESCE((change_request_id)::text, ''::text));

CREATE UNIQUE INDEX conversations_tenant_id_uq ON public.conversations USING btree (tenant_id, id);

CREATE INDEX conversations_tenant_state_idx ON public.conversations USING btree (tenant_id, state);

CREATE INDEX cross_tenant_events_pending_idx ON public.cross_tenant_events USING btree (target_tenant_id, created_at) WHERE (consumed_at IS NULL);

CREATE UNIQUE INDEX cross_tenant_events_rel_revision_uniq ON public.cross_tenant_events USING btree (relationship_id, ((payload ->> 'sourceRevisionId'::text)));

CREATE UNIQUE INDEX cross_tenant_relationships_coordinates_uq ON public.cross_tenant_relationships USING btree (id, source_tenant_id, source_repository_id, target_tenant_id, target_repository_id);

CREATE INDEX cross_tenant_relationships_source_idx ON public.cross_tenant_relationships USING btree (source_repository_id) WHERE (status = 'active'::text);

CREATE INDEX cross_tenant_relationships_target_tenant_idx ON public.cross_tenant_relationships USING btree (target_tenant_id, status);

CREATE INDEX domain_events_status_idx ON public.domain_events USING btree (status, created_at);

CREATE INDEX domain_events_tenant_idx ON public.domain_events USING btree (tenant_id, created_at DESC);

CREATE INDEX ecosystem_facts_status_idx ON public.ecosystem_facts USING btree (status);

CREATE INDEX ecosystem_facts_subject_idx ON public.ecosystem_facts USING btree (ecosystem, lower(subject));

CREATE INDEX feedbacks_agg_idx ON public.feedbacks USING btree (tenant_id, repository_id, fingerprint);

CREATE INDEX finding_dismissals_cr_idx ON public.finding_dismissals USING btree (change_request_id);

CREATE INDEX finding_dismissals_weak_idx ON public.finding_dismissals USING btree (change_request_id, weak_fingerprint);

CREATE INDEX finding_occurrences_finding_idx ON public.finding_occurrences USING btree (finding_id, created_at DESC);

CREATE INDEX finding_occurrences_revision_idx ON public.finding_occurrences USING btree (revision_id);

CREATE INDEX finding_occurrences_tenant_idx ON public.finding_occurrences USING btree (tenant_id);

CREATE INDEX findings_repo_lifecycle_idx ON public.findings USING btree (repository_id, lifecycle);

CREATE INDEX gl_adoptions_tenant_idx ON public.global_learning_adoptions USING btree (tenant_id, status);

CREATE INDEX global_learnings_status_idx ON public.global_learnings USING btree (status);

CREATE INDEX installations_tenant_idx ON public.installations USING btree (tenant_id);

CREATE UNIQUE INDEX jobs_active_dedupe ON public.jobs USING btree (tenant_id, dedupe_key) WHERE ((dedupe_key IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'leased'::text, 'running'::text])));

CREATE INDEX jobs_claim_idx ON public.jobs USING btree (available_at, priority DESC, created_at) WHERE (status = 'queued'::text);

CREATE INDEX jobs_lease_idx ON public.jobs USING btree (lease_expires_at) WHERE (status = ANY (ARRAY['leased'::text, 'running'::text]));

CREATE INDEX jobs_tenant_idx ON public.jobs USING btree (tenant_id, created_at DESC);

CREATE INDEX learning_broadness_idx ON public.learning_proposals USING btree (tenant_id, broadness, status);

CREATE INDEX learning_proposals_repo_status_idx ON public.learning_proposals USING btree (repository_id, status);

CREATE INDEX login_instances_provider_idx ON public.login_instances USING btree (provider);

CREATE INDEX memberships_tenant_idx ON public.memberships USING btree (tenant_id);

CREATE INDEX memberships_user_idx ON public.memberships USING btree (user_id);

CREATE UNIQUE INDEX models_provider_model_id_key ON public.models USING btree (provider, model_id);

CREATE INDEX notifications_pending_email_idx ON public.notifications USING btree (tenant_id, created_at) WHERE (emailed_at IS NULL);

CREATE INDEX notifications_tenant_created_idx ON public.notifications USING btree (tenant_id, created_at DESC);

CREATE UNIQUE INDEX notifications_tenant_dedupe_uniq ON public.notifications USING btree (tenant_id, ((payload ->> 'dedupeKey'::text))) WHERE (NULLIF((payload ->> 'dedupeKey'::text), ''::text) IS NOT NULL);

CREATE INDEX notifications_tenant_unread_idx ON public.notifications USING btree (tenant_id, created_at DESC) WHERE (read_at IS NULL);

CREATE INDEX pending_installations_status_idx ON public.pending_installations USING btree (status, created_at DESC);

CREATE INDEX provider_credentials_tenant_idx ON public.provider_credentials USING btree (tenant_id);

CREATE UNIQUE INDEX provider_events_tenant_id_uq ON public.provider_events USING btree (tenant_id, id);

CREATE INDEX provider_events_tenant_idx ON public.provider_events USING btree (tenant_id, created_at DESC);

CREATE INDEX provider_hosts_tenant_idx ON public.provider_hosts USING btree (tenant_id);

CREATE INDEX publication_records_cr_idx ON public.publication_records USING btree (change_request_id, state);

CREATE INDEX publication_records_tenant_idx ON public.publication_records USING btree (tenant_id, created_at DESC);

CREATE INDEX repositories_installation_idx ON public.repositories USING btree (installation_id);

CREATE UNIQUE INDEX repositories_tenant_id_uq ON public.repositories USING btree (tenant_id, id);

CREATE INDEX repositories_tenant_idx ON public.repositories USING btree (tenant_id);

CREATE INDEX repository_packages_tenant_idx ON public.repository_packages USING btree (tenant_id);

CREATE INDEX repository_relationships_source_idx ON public.repository_relationships USING btree (source_repository_id) WHERE (enabled AND (status = 'active'::text));

CREATE INDEX repository_settings_tenant_idx ON public.repository_settings USING btree (tenant_id);

CREATE INDEX review_costs_repo_created_idx ON public.review_costs USING btree (repository_id, created_at DESC);

CREATE INDEX review_costs_tenant_created_idx ON public.review_costs USING btree (tenant_id, created_at DESC);

CREATE INDEX review_costs_tenant_visibility_idx ON public.review_costs USING btree (tenant_id, created_at, repo_visibility);

CREATE INDEX review_progress_finished_idx ON public.review_progress USING btree (tenant_id, finished_at) WHERE (finished_at IS NOT NULL);

CREATE INDEX review_progress_live_idx ON public.review_progress USING btree (tenant_id, updated_at DESC) WHERE (finished_at IS NULL);

CREATE INDEX revisions_cr_idx ON public.revisions USING btree (change_request_id, created_at DESC);

CREATE UNIQUE INDEX revisions_tenant_id_uq ON public.revisions USING btree (tenant_id, id);

CREATE UNIQUE INDEX runner_pools_shared_name_uniq ON public.runner_pools USING btree (name) WHERE (tenant_id IS NULL);

CREATE UNIQUE INDEX runner_pools_tenant_name_uniq ON public.runner_pools USING btree (tenant_id, name) WHERE (tenant_id IS NOT NULL);

CREATE UNIQUE INDEX sandbox_vm_leases_sandbox_idx ON public.sandbox_vm_leases USING btree (sandbox_id) WHERE (sandbox_id IS NOT NULL);

CREATE INDEX sandbox_vm_leases_vm_idx ON public.sandbox_vm_leases USING btree (vm_name);

CREATE UNIQUE INDEX service_credentials_org_uq ON public.service_credentials USING btree (tenant_id, service) WHERE ((repository_id IS NULL) AND (user_id IS NULL));

CREATE UNIQUE INDEX service_credentials_repo_uq ON public.service_credentials USING btree (tenant_id, repository_id, service) WHERE (repository_id IS NOT NULL);

CREATE UNIQUE INDEX service_credentials_user_uq ON public.service_credentials USING btree (tenant_id, user_id, service) WHERE (user_id IS NOT NULL);

CREATE INDEX subscriptions_tenant_idx ON public.subscriptions USING btree (tenant_id);

CREATE INDEX tenant_invites_email_idx ON public.tenant_invites USING btree (email);

CREATE INDEX tenant_invites_tenant_idx ON public.tenant_invites USING btree (tenant_id);

CREATE INDEX user_identities_user_idx ON public.user_identities USING btree (user_id);

CREATE INDEX workers_pool_idx ON public.workers USING btree (pool_id);

ALTER TABLE ONLY public.action_plans
    ADD CONSTRAINT action_plans_tenant_conversation_fk FOREIGN KEY (tenant_id, conversation_id) REFERENCES public.conversations(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.action_plans
    ADD CONSTRAINT action_plans_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memories_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.agent_memories
    ADD CONSTRAINT agent_memories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.change_requests
    ADD CONSTRAINT change_requests_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.change_requests
    ADD CONSTRAINT change_requests_stacked_on_change_request_id_fkey FOREIGN KEY (stacked_on_change_request_id) REFERENCES public.change_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.change_requests
    ADD CONSTRAINT change_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.change_requests
    ADD CONSTRAINT change_requests_tenant_repository_fk FOREIGN KEY (tenant_id, repository_id) REFERENCES public.repositories(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.conversation_messages
    ADD CONSTRAINT conversation_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_change_request_id_fkey FOREIGN KEY (change_request_id) REFERENCES public.change_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_tenant_change_request_fk FOREIGN KEY (tenant_id, change_request_id) REFERENCES public.change_requests(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_tenant_repository_fk FOREIGN KEY (tenant_id, repository_id) REFERENCES public.repositories(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.cross_tenant_events
    ADD CONSTRAINT cross_tenant_events_relationship_coordinates_fk FOREIGN KEY (relationship_id, source_tenant_id, source_repository_id, target_tenant_id, target_repository_id) REFERENCES public.cross_tenant_relationships(id, source_tenant_id, source_repository_id, target_tenant_id, target_repository_id) NOT VALID;

ALTER TABLE ONLY public.cross_tenant_events
    ADD CONSTRAINT cross_tenant_events_relationship_id_fkey FOREIGN KEY (relationship_id) REFERENCES public.cross_tenant_relationships(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.cross_tenant_events
    ADD CONSTRAINT cross_tenant_events_source_repository_fk FOREIGN KEY (source_tenant_id, source_repository_id) REFERENCES public.repositories(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.cross_tenant_events
    ADD CONSTRAINT cross_tenant_events_source_repository_id_fkey FOREIGN KEY (source_repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.cross_tenant_events
    ADD CONSTRAINT cross_tenant_events_source_tenant_id_fkey FOREIGN KEY (source_tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.cross_tenant_events
    ADD CONSTRAINT cross_tenant_events_target_repository_fk FOREIGN KEY (target_tenant_id, target_repository_id) REFERENCES public.repositories(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.cross_tenant_events
    ADD CONSTRAINT cross_tenant_events_target_repository_id_fkey FOREIGN KEY (target_repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.cross_tenant_events
    ADD CONSTRAINT cross_tenant_events_target_tenant_id_fkey FOREIGN KEY (target_tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.cross_tenant_relationships
    ADD CONSTRAINT cross_tenant_relationships_source_repository_fk FOREIGN KEY (source_tenant_id, source_repository_id) REFERENCES public.repositories(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.cross_tenant_relationships
    ADD CONSTRAINT cross_tenant_relationships_source_repository_id_fkey FOREIGN KEY (source_repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.cross_tenant_relationships
    ADD CONSTRAINT cross_tenant_relationships_source_tenant_id_fkey FOREIGN KEY (source_tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.cross_tenant_relationships
    ADD CONSTRAINT cross_tenant_relationships_target_repository_fk FOREIGN KEY (target_tenant_id, target_repository_id) REFERENCES public.repositories(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.cross_tenant_relationships
    ADD CONSTRAINT cross_tenant_relationships_target_repository_id_fkey FOREIGN KEY (target_repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.cross_tenant_relationships
    ADD CONSTRAINT cross_tenant_relationships_target_tenant_id_fkey FOREIGN KEY (target_tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_change_request_id_fkey FOREIGN KEY (change_request_id) REFERENCES public.change_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_provider_event_id_fkey FOREIGN KEY (provider_event_id) REFERENCES public.provider_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_tenant_change_request_fk FOREIGN KEY (tenant_id, change_request_id) REFERENCES public.change_requests(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_tenant_provider_event_fk FOREIGN KEY (tenant_id, provider_event_id) REFERENCES public.provider_events(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.domain_events
    ADD CONSTRAINT domain_events_tenant_repository_fk FOREIGN KEY (tenant_id, repository_id) REFERENCES public.repositories(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.feedbacks
    ADD CONSTRAINT feedbacks_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedbacks
    ADD CONSTRAINT feedbacks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.finding_dismissals
    ADD CONSTRAINT finding_dismissals_change_request_id_fkey FOREIGN KEY (change_request_id) REFERENCES public.change_requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.finding_dismissals
    ADD CONSTRAINT finding_dismissals_finding_id_fkey FOREIGN KEY (finding_id) REFERENCES public.findings(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.finding_dismissals
    ADD CONSTRAINT finding_dismissals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.finding_occurrences
    ADD CONSTRAINT finding_occurrences_finding_id_fkey FOREIGN KEY (finding_id) REFERENCES public.findings(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.finding_occurrences
    ADD CONSTRAINT finding_occurrences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.findings
    ADD CONSTRAINT findings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.global_learning_adoptions
    ADD CONSTRAINT global_learning_adoptions_global_learning_id_fkey FOREIGN KEY (global_learning_id) REFERENCES public.global_learnings(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.global_learning_adoptions
    ADD CONSTRAINT global_learning_adoptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.installations
    ADD CONSTRAINT installations_provider_host_id_fkey FOREIGN KEY (provider_host_id) REFERENCES public.provider_hosts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.installations
    ADD CONSTRAINT installations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_attempts
    ADD CONSTRAINT job_attempts_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_proposals
    ADD CONSTRAINT learning_proposals_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_proposals
    ADD CONSTRAINT learning_proposals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.plan_stage_models
    ADD CONSTRAINT plan_stage_models_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.plan_stage_models
    ADD CONSTRAINT plan_stage_models_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.plan_stage_policies
    ADD CONSTRAINT plan_stage_policies_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pr_coverage
    ADD CONSTRAINT pr_coverage_change_request_id_fkey FOREIGN KEY (change_request_id) REFERENCES public.change_requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.pr_coverage
    ADD CONSTRAINT pr_coverage_tenant_change_request_fk FOREIGN KEY (tenant_id, change_request_id) REFERENCES public.change_requests(tenant_id, id);

ALTER TABLE ONLY public.pr_coverage
    ADD CONSTRAINT pr_coverage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provider_credentials
    ADD CONSTRAINT provider_credentials_provider_host_id_fkey FOREIGN KEY (provider_host_id) REFERENCES public.provider_hosts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provider_credentials
    ADD CONSTRAINT provider_credentials_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provider_events
    ADD CONSTRAINT provider_events_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.installations(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.provider_events
    ADD CONSTRAINT provider_events_provider_host_id_fkey FOREIGN KEY (provider_host_id) REFERENCES public.provider_hosts(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.provider_events
    ADD CONSTRAINT provider_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.provider_hosts
    ADD CONSTRAINT provider_hosts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.publication_records
    ADD CONSTRAINT publication_records_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES public.installations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_provider_host_id_fkey FOREIGN KEY (provider_host_id) REFERENCES public.provider_hosts(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repositories
    ADD CONSTRAINT repositories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repository_packages
    ADD CONSTRAINT repository_packages_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repository_packages
    ADD CONSTRAINT repository_packages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repository_relationships
    ADD CONSTRAINT repository_relationships_source_repository_id_fkey FOREIGN KEY (source_repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repository_relationships
    ADD CONSTRAINT repository_relationships_target_repository_id_fkey FOREIGN KEY (target_repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repository_relationships
    ADD CONSTRAINT repository_relationships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repository_settings
    ADD CONSTRAINT repository_settings_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repository_settings
    ADD CONSTRAINT repository_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.repository_settings
    ADD CONSTRAINT repository_settings_tenant_repository_fk FOREIGN KEY (tenant_id, repository_id) REFERENCES public.repositories(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.review_costs
    ADD CONSTRAINT review_costs_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.review_costs
    ADD CONSTRAINT review_costs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.review_progress
    ADD CONSTRAINT review_progress_change_request_id_fkey FOREIGN KEY (change_request_id) REFERENCES public.change_requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.review_progress
    ADD CONSTRAINT review_progress_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.review_progress
    ADD CONSTRAINT review_progress_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.review_progress
    ADD CONSTRAINT review_progress_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_change_request_id_fkey FOREIGN KEY (change_request_id) REFERENCES public.change_requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_tenant_change_request_fk FOREIGN KEY (tenant_id, change_request_id) REFERENCES public.change_requests(tenant_id, id) NOT VALID;

ALTER TABLE ONLY public.revisions
    ADD CONSTRAINT revisions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.runner_pools
    ADD CONSTRAINT runner_pools_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sandbox_vm_leases
    ADD CONSTRAINT sandbox_vm_leases_vm_name_fkey FOREIGN KEY (vm_name) REFERENCES public.sandbox_vms(name) ON DELETE CASCADE;

ALTER TABLE ONLY public.service_credentials
    ADD CONSTRAINT service_credentials_repository_id_fkey FOREIGN KEY (repository_id) REFERENCES public.repositories(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.service_credentials
    ADD CONSTRAINT service_credentials_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.service_credentials
    ADD CONSTRAINT service_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id);

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_invites
    ADD CONSTRAINT tenant_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.tenant_invites
    ADD CONSTRAINT tenant_invites_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_identities
    ADD CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workers
    ADD CONSTRAINT workers_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES public.runner_pools(id) ON DELETE CASCADE;

ALTER TABLE public.action_plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.agent_memories ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.change_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cross_tenant_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cross_tenant_relationships ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.domain_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.finding_dismissals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.finding_occurrences ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.findings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.global_learning_adoptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.installations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.learning_proposals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.pr_coverage ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.provider_credentials ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.provider_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.provider_hosts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.publication_records ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.repositories ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.repository_packages ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.repository_relationships ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.repository_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.review_costs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.review_progress ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.service_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.action_plans USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.agent_memories USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.artifacts USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.audit_events USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.change_requests USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.conversations USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.domain_events USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.finding_dismissals USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.finding_occurrences USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.findings USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.global_learning_adoptions USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.installations USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.jobs USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.learning_proposals USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.memberships USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.notifications USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.pr_coverage USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.provider_credentials USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.provider_events USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.provider_hosts USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.publication_records USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.repositories USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.repository_packages USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.repository_relationships USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.repository_settings USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.review_costs USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.review_progress USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.revisions USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_isolation ON public.service_credentials USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR (tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_source_insert ON public.cross_tenant_events FOR INSERT WITH CHECK (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((source_tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_target_update ON public.cross_tenant_events FOR UPDATE USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((target_tenant_id)::text = current_setting('app.tenant_id'::text, true)))) WITH CHECK (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((target_tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_visibility ON public.cross_tenant_relationships USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((source_tenant_id)::text = current_setting('app.tenant_id'::text, true)) OR ((target_tenant_id)::text = current_setting('app.tenant_id'::text, true))));

CREATE POLICY tenant_visibility_select ON public.cross_tenant_events FOR SELECT USING (((NULLIF(current_setting('app.tenant_id'::text, true), ''::text) IS NULL) OR ((source_tenant_id)::text = current_setting('app.tenant_id'::text, true)) OR ((target_tenant_id)::text = current_setting('app.tenant_id'::text, true))));


-- internal = operator-owned tenants.
INSERT INTO public.plans (id, key, name, model_tier, monthly_review_quota, monthly_token_quota, max_concurrency, features, active, created_at, monthly_cost_cap_usd, daily_cost_cap_usd, review_cost_cap_usd) VALUES ('d61b06ee-07c4-44a7-9d39-8cfdfe1cd945', 'pro', 'Pro', 'balanced', 500, 100000000, 8, '{}', true, '2026-10-04 13:43:09.909322+00', NULL, NULL, NULL);
INSERT INTO public.plans (id, key, name, model_tier, monthly_review_quota, monthly_token_quota, max_concurrency, features, active, created_at, monthly_cost_cap_usd, daily_cost_cap_usd, review_cost_cap_usd) VALUES ('4c6387c3-f2fd-4473-8260-cdf06051e5af', 'enterprise', 'Enterprise', 'quality', NULL, NULL, 16, '{}', true, '2026-10-04 13:43:09.909322+00', NULL, NULL, NULL);
INSERT INTO public.plans (id, key, name, model_tier, monthly_review_quota, monthly_token_quota, max_concurrency, features, active, created_at, monthly_cost_cap_usd, daily_cost_cap_usd, review_cost_cap_usd) VALUES ('abf19304-7a0c-40e2-bb3f-c01b8b4e2d9d', 'free', 'Free', 'cheap', NULL, NULL, 2, '{}', true, '2026-10-04 13:43:09.909322+00', 3.0000, NULL, NULL);
INSERT INTO public.plans (id, key, name, model_tier, monthly_review_quota, monthly_token_quota, max_concurrency, features, active, created_at, monthly_cost_cap_usd, daily_cost_cap_usd, review_cost_cap_usd) VALUES ('0b316353-5517-4f10-b93c-050bd99afd3b', 'internal', 'Internal', 'quality', NULL, NULL, 8, '{}', true, '2026-10-04 13:43:10.070018+00', NULL, 0.0000, 0.0000);
