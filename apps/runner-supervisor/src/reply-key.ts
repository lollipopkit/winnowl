import { createHash } from 'node:crypto';

/** A new explanation on the same head is a new re-check; the previous key must not swallow it. */
export function replyKey(authorReply: string | undefined): string {
  return authorReply ? `:${createHash('sha256').update(authorReply).digest('hex').slice(0, 12)}` : '';
}
