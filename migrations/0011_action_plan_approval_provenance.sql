-- Approval channel: console approvals are checked against tenant membership, `@bot approve`
-- comments against provider permissions; execution-time revalidation uses the matching rule.
alter table action_plans
    add column approval_provenance jsonb;

comment on column action_plans.approval_provenance is
    'Who approved and in which channel: {"source":"console","actorId":…} or {"source":"provider-comment","actorId":…,"login":…,"host":…}. Null = legacy row (validated as a console approval).';
