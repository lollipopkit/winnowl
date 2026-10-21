import type { Actor, ChangeRequestRef, IssueRef } from '@reviewbot/domain';

/** Every external side effect carries an idempotency key. */
export interface IdempotencyContext {
  key: string;
}

export interface RichComment {
  markdown: string;
  /** Logins allowed to be pinged; every other `@name` is neutralised on output (guardMentions). */
  mentions?: readonly string[];
}

export interface CommentRef {
  nativeId: string;
  threadNativeId?: string;
  url?: string;
  /** Lets editComment locate the repository. */
  changeRequest?: ChangeRequestRef;
  /** Conversation (issue) comment or inline review comment. */
  scope?: 'conversation' | 'review';
}

export interface CommentReceipt {
  nativeId: string;
  threadNativeId?: string;
  url?: string;
}

export interface TopLevelComment {
  nativeId: string;
  body: string;
  /** Posted by this bot; marker matching and edits apply only to own comments. */
  isBot: boolean;
}

export interface DiscussionThreadRef {
  nativeId: string;
  /** Lets reply/resolve locate the repository and number. */
  changeRequest?: ChangeRequestRef;
}

export interface DiscussionThreadComment {
  nativeId: string;
  author: Actor;
  body: string;
  createdAt: string;
  /** Posted by this bot; only own threads are resolved. */
  isBot: boolean;
}

/** Canonical inline position from the anchor resolver; adapters map it to native fields. */
export interface ProviderAnchor {
  path: string;
  side: 'base' | 'head';
  line: number;
  startLine?: number;
  startSide?: 'base' | 'head';
}

export interface DiscussionThread {
  ref: DiscussionThreadRef;
  resolved: boolean;
  comments: DiscussionThreadComment[];
  anchor?: ProviderAnchor;
}

export type DiscussionTarget =
  | { kind: 'change-request'; ref: ChangeRequestRef }
  | { kind: 'issue'; ref: IssueRef };
