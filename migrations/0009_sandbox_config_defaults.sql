-- Strip stale schema defaults from the mirrored config unless set explicitly via `panel_settings`.
update repository_settings
set settings = jsonb_set(settings, '{sandbox,network}', (settings #> '{sandbox,network}') - 'mode')
where settings #>> '{sandbox,network,mode}' = 'none'
  and panel_settings #>> '{sandbox,network,mode}' is null;

update repository_settings
set settings = jsonb_set(settings, '{sandbox,resources}', '{}'::jsonb)
where settings #> '{sandbox,resources}' = '{"cpu": 4, "disk_mb": 20480, "memory_mb": 8192, "timeout_seconds": 1800}'::jsonb
  and panel_settings #> '{sandbox,resources}' is null;
