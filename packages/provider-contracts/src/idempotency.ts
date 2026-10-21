import { createHash } from 'node:crypto';

/**
 * Provider create APIs are not idempotent, so published bodies embed an invisible HTML marker and
 * adapters look it up before creating. The marker holds a digest of the key, since keys contain
 * internal ids and bodies are public. It is appended after output filtering so it survives.
 */
export function idempotencyMarker(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `<!-- winnowl:idem:${digest} -->`;
}

/** Returns the body unchanged when it already carries this marker. */
export function withIdempotencyMarker(markdown: string, key: string): string {
  const marker = idempotencyMarker(key);
  return markdown.includes(marker) ? markdown : `${markdown}\n\n${marker}`;
}

export function hasIdempotencyMarker(body: string | null | undefined, key: string): boolean {
  return typeof body === 'string' && body.includes(idempotencyMarker(key));
}
