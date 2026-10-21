---
name: performance
description: Work that grows faster than the input — repeated scans, nested loops, N+1 queries, unbounded buffers.
---
Check each of these against the changed code and the code it calls. Think about the largest input
the code accepts, not the example in the test.

- A loop that calls something which itself walks the whole input: `indexOf` / `includes` / `find`,
  re-splitting or re-scanning a string or array, recomputing a line or offset from the start for
  every item. That is quadratic even when each call looks cheap.
- Work repeated per item that could be done once: sorting, regex compilation, parsing, building a
  lookup table inside the loop.
- String or array building by repeated concatenation or `concat` / spread in a loop.
- One query, request or file read per item (N+1) where a batch exists.
- Buffers, caches, queues or maps that grow with input and are never bounded or evicted.
- Recursion whose depth follows input size (stack overflow on large or deeply nested input).

Report only with a concrete size: which input of what size makes which call run how many times.
"Could be slow" is not a finding.
