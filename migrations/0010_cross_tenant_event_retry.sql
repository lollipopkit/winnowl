-- Per-event retry state; consumed_at (success) and failed_at (gave up) are both terminal.
alter table cross_tenant_events
    add column attempt_count integer not null default 0,
    add column last_error jsonb,
    add column next_attempt_at timestamp with time zone,
    add column failed_at timestamp with time zone;

drop index if exists cross_tenant_events_pending_idx;
create index cross_tenant_events_pending_idx
    on cross_tenant_events (target_tenant_id, created_at)
    where consumed_at is null and failed_at is null;
