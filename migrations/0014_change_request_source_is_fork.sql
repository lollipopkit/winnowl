-- Only same-repository PRs can be stacked on; existing links are dropped and re-inferred on the next PR event.
alter table change_requests add column source_is_fork boolean;
comment on column change_requests.source_is_fork is '§26.7: source branch lives in a fork; null when the forge did not say. Only false rows can be a stack parent.';
update change_requests set stacked_on_change_request_id = null where stacked_on_change_request_id is not null;
