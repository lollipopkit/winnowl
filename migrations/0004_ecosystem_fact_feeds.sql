-- Operator-registered release-note pages; extracted facts land as `proposed` with origin `feed`.
create table ecosystem_fact_feeds (
  id uuid primary key,
  ecosystem text not null,
  -- Package / SDK the page is about; extracted facts default to it.
  subject text not null,
  url text not null unique,
  label text,
  enabled boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  last_fetched_at timestamptz,
  last_content_hash text,
  last_error text,
  -- Facts proposed by the last run that saw changed content, and what that run cost.
  last_proposed integer not null default 0,
  last_cost_usd numeric(12, 6)
);

alter table ecosystem_facts drop constraint ecosystem_facts_origin_ck;
alter table ecosystem_facts add constraint ecosystem_facts_origin_ck check (origin in ('review', 'operator', 'feed'));
