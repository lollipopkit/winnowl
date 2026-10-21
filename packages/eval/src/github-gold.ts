import { parseCodeRabbitGold, type CodeRabbitComment } from './gold.js';
import type { EvalFinding } from './types.js';

/** Subset of REST `pulls/:n/comments`. */
export interface GhReviewComment {
  path: string;
  line?: number | null;
  body: string;
  user?: { login?: string } | null;
  /**
   * Commit the comment was first made on (unlike `commit_id`, never rewritten). Gold must align to
   * this, not the final head: a bug fixed later would otherwise count as a miss.
   */
  original_commit_id?: string;
}

const CODERABBIT_LOGINS = new Set(['coderabbitai[bot]', 'coderabbitai', 'coderabbit-ai[bot]']);

function isCodeRabbitComment(c: GhReviewComment): boolean {
  return Boolean(c.user?.login && CODERABBIT_LOGINS.has(c.user.login));
}

export function codeRabbitCommentsFrom(comments: GhReviewComment[]): CodeRabbitComment[] {
  return comments
    .filter(isCodeRabbitComment)
    .map((c) => ({ path: c.path, ...(c.line != null ? { line: c.line } : {}), body: c.body }));
}

export function goldFromReviewComments(comments: GhReviewComment[]): EvalFinding[] {
  return parseCodeRabbitGold(codeRabbitCommentsFrom(comments));
}

/**
 * One group per review round; callers diff `base -> original_commit_id` per group.
 * Comments without `original_commit_id` go under key `''`.
 */
export function groupCodeRabbitCommentsByCommit(comments: GhReviewComment[]): Map<string, GhReviewComment[]> {
  const groups = new Map<string, GhReviewComment[]>();
  for (const c of comments.filter(isCodeRabbitComment)) {
    const key = c.original_commit_id ?? '';
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  return groups;
}
