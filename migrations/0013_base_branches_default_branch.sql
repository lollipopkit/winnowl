-- Strip the stale `["main"]` default from the mirrored config unless set explicitly via
-- `panel_settings`; a skipped review never rewrites the mirror, so it would not heal itself.
update repository_settings
set settings = jsonb_set(settings, '{reviews,auto,base_branches}', '[]'::jsonb)
where settings #> '{reviews,auto,base_branches}' = '["main"]'::jsonb
  and panel_settings #> '{reviews,auto,base_branches}' is null;
