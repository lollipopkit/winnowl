-- Platform settings have no tenant, so their history cannot live in audit_events.
create table platform_setting_changes (
    id uuid primary key,
    key text not null,
    old_value text,
    -- null = reset to environment/default
    new_value text,
    actor text,
    changed_at timestamptz not null default now()
);
create index platform_setting_changes_key_idx on platform_setting_changes (key, changed_at desc);
