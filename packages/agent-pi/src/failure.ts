/**
 * LLM stream failure kinds. pi does not throw on failure; it sets stopReason='error'|'aborted' plus
 * `errorMessage`, and has no content_filter stop reason, so the message text is the only reliable signal.
 */
export type StreamFailureKind =
  | 'content_filter'
  | 'context_overflow'
  | 'rate_limit'
  | 'model_unavailable'
  | 'gateway_transport'
  | 'timeout'
  | 'unknown';

/** Pattern order matters; unmatched messages are `unknown` (retryable), never content_filter. */
export function classifyStreamFailure(errorMessage?: string): StreamFailureKind {
  const m = (errorMessage ?? '').toLowerCase();
  if (!m) return 'unknown';
  if (/content[_ ]?filter|moderation|flagged|safety system|content policy|responsible ai|refus(e|ed|al)/.test(m)) {
    return 'content_filter';
  }
  // Not `too many tokens`: rate-limit messages (`tokens per minute`) use it too.
  if (
    /context[_ ]?length|context[_ ]?window|maximum context|prompt is too long|input is too long/.test(
      m,
    )
  ) {
    return 'context_overflow';
  }
  // Per-model cooldown (gateway 429 `model_cooldown` / 529) or a model the gateway does not serve: must precede
  // rate_limit, which it resembles, because it is model-scoped, so switching models helps.
  if (/model_cooldown|model_unavailable|model_not_found|credentials for model|cooling down/.test(m)) {
    return 'model_unavailable';
  }
  // Rate limits are key-scoped, so they must not trigger a model fallback; must precede gateway_transport.
  if (/429|too many requests|rate[_ ]?limit|quota|concurrency limit|concurrent requests/.test(m)) {
    return 'rate_limit';
  }
  if (
    /could not parse|event: ?error|econnreset|econnrefused|socket hang|network|fetch failed|unexpected end|premature close|stream (closed|error|ended|interrupted)|bad gateway|service unavailable|gateway timeout|50[234]|529|overloaded|temporarily unavailable/.test(
      m,
    )
  ) {
    return 'gateway_transport';
  }
  // Aborts count as timeouts: the request timeout watchdog is the only abort source.
  if (/tim(e|ed)[ -]?out|etimedout|deadline exceeded|abort(ed)?/.test(m)) return 'timeout';
  return 'unknown';
}

/** `reset_seconds` from a gateway `model_cooldown` error. */
export function cooldownResetSeconds(errorMessage?: string): number | undefined {
  const m = /"?reset_seconds"?\s*:\s*(\d+)/.exec(errorMessage ?? '');
  return m ? Number(m[1]) : undefined;
}

export function isRetryableStreamFailure(kind: StreamFailureKind): boolean {
  // model_unavailable resets take hours; short backoff retries cannot help.
  return kind !== 'content_filter' && kind !== 'context_overflow' && kind !== 'model_unavailable';
}

/** Everything but `rate_limit` (key-scoped, same for every model) may succeed on another model. */
export function shouldTryAnotherModel(kind: StreamFailureKind): boolean {
  return kind !== 'rate_limit';
}
