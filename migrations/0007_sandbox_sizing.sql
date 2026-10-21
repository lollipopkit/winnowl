-- Peak sandbox needs per repository: memory = highest non-reclaimable use, disk = highest slot use.
create table sandbox_sizing (
  tenant_id uuid not null,
  repository_id uuid not null references repositories(id) on delete cascade,
  kind text not null,
  memory_peak_mb integer not null,
  disk_peak_mb integer not null,
  -- An OOM-killed run counts too (its peak is a lower bound).
  samples integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (repository_id, kind)
);

alter table sandbox_sizing enable row level security;
alter table only sandbox_sizing force row level security;
create policy tenant_isolation on sandbox_sizing using (
  nullif(current_setting('app.tenant_id', true), '') is null or tenant_id::text = current_setting('app.tenant_id', true)
);
