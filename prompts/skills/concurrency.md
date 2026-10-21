---
name: concurrency
description: Races, shared mutable state, async ordering, locks, cancellation and retries.
---
Check each of these against the changed code and the code it calls.

- Shared mutable state touched from more than one task, thread, isolate or request without a
  lock, atomic, or single-owner design. Read-modify-write sequences (check-then-act, `if
  (!map.has(k)) map.set(k, …)`, counters) are the usual offenders.
- Async ordering: code after an `await` that assumes the world did not change while it waited
  (the entry was deleted, the user logged out, a newer request already finished). Last-writer-wins
  where the older response can arrive later and overwrite the newer one.
- Locks: held across an `await` or I/O, taken in inconsistent order (deadlock), not released on
  the error path, or scoped wider or narrower than the invariant they protect.
- Cancellation and timeouts: work that keeps running after the caller gave up, timers or
  subscriptions not cancelled, `AbortSignal` not passed through.
- Retries: non-idempotent operations retried (double charge, duplicate insert), retries without
  backoff or a bound, retry storms after a shared dependency fails.
- Fire-and-forget promises whose rejection is unhandled or whose result is needed later.
- Database concurrency: lost updates without row locks or version checks, unique constraints
  relied on but missing, transactions spanning network calls.

Report only a concrete interleaving: which two operations, in which order, produce which wrong
state. "Could be racy" is not a finding.
