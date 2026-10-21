-- Why the last review that should have used BYOK ran on the platform key (set by the runner, cleared on save).
alter table service_credentials
  add column last_used_at timestamptz,
  add column last_error text,
  add column last_error_at timestamptz;
