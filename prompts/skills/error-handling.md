---
name: error-handling
description: Error handling — swallowed errors, partial failure, wrong error types, misleading success.
---
- Errors caught and ignored, or logged and then treated as success, so the caller proceeds on bad
  state.
- Partial failure: a multi-step operation that can stop halfway (after the first write, before the
  second) and leave data inconsistent, with no rollback or compensation.
- Error paths that return a default value indistinguishable from a real result (empty list, 0,
  null) where the caller cannot tell "none" from "failed".
- Exceptions thrown from destructors, `finally`, cleanup or event handlers that mask the original
  error or crash the process.
- Promise rejections and async errors not awaited or not handled.
- User-facing errors that leak internals (stack traces, SQL, file paths, tokens).
- Changed error types or codes that existing callers still match on.

A finding names the failure, what the code does with it, and the wrong outcome that follows.
