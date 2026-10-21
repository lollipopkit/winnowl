-- The repository's `.winnowl.yaml` as written (one layer), so the effective config can be resolved at read time
-- with the organization's defaults underneath; `settings` stays a display mirror.
alter table repository_settings add column file_settings jsonb;
