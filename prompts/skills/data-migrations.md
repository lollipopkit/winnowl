---
name: data-migrations
description: Schema and data migrations — backward compatibility, locking, data loss, rollout order.
---
- Rollout order: new code reading a column or table that the migration has not created yet, or old
  code (still running during deploy) breaking on the new schema. Renames and drops need an expand
  and contract sequence.
- Locking and duration: operations that rewrite or lock large tables (adding a non-null column
  with a default on old engines, building an index without `CONCURRENTLY`, changing a type).
- Data loss: dropped columns or tables still read somewhere, narrowing types, `ON DELETE CASCADE`
  added to existing relations, backfills that overwrite values.
- Constraints: `NOT NULL`, unique or foreign keys added over existing rows that violate them.
- Reversibility: migrations with no way back when a rollback is part of the deploy process.
- Code that builds queries against the new schema: missing indexes for new access patterns,
  queries that no longer use a tenant filter.

A finding names the migration step, the running code it conflicts with, and what breaks.
