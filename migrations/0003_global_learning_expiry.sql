-- Enforced at read time: expired rows stay `approved` but are no longer injected or offered for adoption.
alter table global_learnings add column expires_at timestamptz;
