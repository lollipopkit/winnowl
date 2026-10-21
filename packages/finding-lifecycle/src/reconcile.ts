/**
 * Finding lifecycle states. Cross-round classification lives in review-orchestrator (`match.ts`,
 * `resolution.ts`); `moved` / `modified` currently have no producer.
 */
export type FindingLifecycle =
  | 'new'
  | 'published'
  | 'persisted'
  | 'moved'
  | 'modified'
  | 'resolved'
  | 'dismissed'
  | 'superseded'
  | 'stale'
  // Withdrawn as a false positive on re-verification (unlike `resolved`); not active.
  | 'retracted';
