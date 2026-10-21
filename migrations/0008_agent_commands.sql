-- Kept 30 days (retention class raw-command-logs).
create table agent_commands (
  id uuid primary key,
  tenant_id uuid not null,
  job_id uuid,
  repository_id uuid references repositories(id) on delete cascade,
  command text not null,
  purpose text,
  verdict text not null check (verdict in ('allow', 'deny')),
  decided_by text not null check (decided_by in ('rule', 'judge')),
  rule text not null,
  reason text not null,
  judge_cost_usd numeric(12, 6),
  exit_code integer,
  timed_out boolean,
  oom_killed boolean,
  duration_ms integer,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index agent_commands_job_idx on agent_commands (job_id, created_at);
create index agent_commands_tenant_created_idx on agent_commands (tenant_id, created_at);

alter table agent_commands enable row level security;
alter table only agent_commands force row level security;
create policy tenant_isolation on agent_commands using (
  nullif(current_setting('app.tenant_id', true), '') is null or tenant_id::text = current_setting('app.tenant_id', true)
);
