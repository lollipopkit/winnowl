---
name: resource-lifetime
description: Leaks and unbounded growth — listeners, timers, subscriptions, handles, connections, caches, queues.
---
For every resource the change acquires, find where it is released, on every path:

- Event listeners, subscriptions, observers, streams: added without a matching remove when the
  owner is disposed, unmounted or closed.
- Timers and intervals not cleared; retries or polling loops with no stop condition.
- File handles, sockets, database connections, transactions, locks: not closed on the error path
  (missing `finally`, `using`, `defer`, `with`).
- Caches, maps, arrays and queues keyed by request data or ids that only grow: no eviction, no
  bound, no TTL — a slow memory leak in a long-running process.
- Goroutines, tasks or workers started per request that can block forever.
- Temporary files and directories not removed.

A finding names the resource, the path that skips the release, and how it accumulates.
