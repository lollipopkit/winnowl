-- One `review_costs` row per review run (a revision can be reviewed more than once).
alter table review_costs
    drop constraint review_costs_revision_id_key;

create index review_costs_revision_idx on review_costs (revision_id, created_at desc);
