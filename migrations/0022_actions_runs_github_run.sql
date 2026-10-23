-- The workflow run that claimed a review, so a retry can re-run it (its event and OIDC ref stay the pull request).
alter table actions_runs add column github_run_id text;
