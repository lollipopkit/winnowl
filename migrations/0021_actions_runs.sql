-- Reviews whose executor runs in the repository's GitHub Actions: the runner parks the spec here, the action
-- claims it with an OIDC token and posts the output back. spec/output are cleared once the runner has read them.
create table actions_runs (
  id uuid primary key,
  tenant_id uuid not null,
  job_id uuid not null,
  repository_id uuid not null references repositories(id) on delete cascade,
  change_request_number integer not null,
  head_sha text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'closed')),
  executor_image text not null,
  spec jsonb,
  -- blake3 of the per-run bearer token handed out at claim; the token itself is never stored.
  token_hash text,
  progress jsonb,
  cancel_requested boolean not null default false,
  output jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz
);
create unique index actions_runs_active_job_uq on actions_runs (job_id) where status in ('pending', 'running');
create index actions_runs_claim_idx on actions_runs (repository_id, change_request_number, head_sha) where status = 'pending';

alter table actions_runs enable row level security;
alter table only actions_runs force row level security;
create policy tenant_isolation on actions_runs using (
  nullif(current_setting('app.tenant_id', true), '') is null or tenant_id::text = current_setting('app.tenant_id', true)
);

-- sandbox.runner_policy was never read and is replaced by sandbox.runner; the strict schema would reject it.
update repository_settings set
  settings = settings #- '{sandbox,runner_policy}',
  panel_settings = panel_settings #- '{sandbox,runner_policy}',
  file_settings = file_settings #- '{sandbox,runner_policy}';
update tenants set settings = settings #- '{sandbox,runner_policy}' where settings ? 'sandbox';
