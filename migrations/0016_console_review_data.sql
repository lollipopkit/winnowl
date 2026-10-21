alter table change_requests add column title text;
-- Merge-check result of the latest review of this revision; recomputed when findings are dismissed or re-verified.
alter table revisions add column gate_state text check (gate_state in ('pass', 'block'));
alter table revisions add column blocking_count integer;
alter table finding_dismissals add column reason text;
alter table finding_occurrences add column suppress_reason text;
-- Head lines around the anchor as reviewed, and the validated committable suggestion.
alter table finding_occurrences add column code_context jsonb;
alter table finding_occurrences add column suggestion jsonb;
