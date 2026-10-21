export type InteractionIntent =
  | 'review'
  | 'full-review'
  | 'explain-finding'
  | 'challenge-finding'
  | 'reverify'
  | 'resolve-finding'
  | 'ignore-finding'
  | 'unignore-finding'
  | 'ignore-pr'
  | 'pause-reviews'
  | 'resume-reviews'
  | 'fix-finding'
  | 'fix-all'
  | 'generate-tests'
  | 'generate-docs'
  | 'generate-diagram'
  | 'simplify'
  | 'resolve-conflict'
  | 'add-comments'
  | 'run-command'
  | 'create-issue'
  | 'plan-issue'
  | 'implement-issue'
  | 'show-config'
  | 'propose-learning'
  | 'approve-learning'
  | 'approve-plan'
  | 'feedback'
  | 'help';

export interface ParsedIntent {
  intent: InteractionIntent;
  /** e.g. run <command> */
  argument?: string;
  /** `agent`: the conversation agent ran the command on the commenter's behalf, under their permissions. */
  source: 'command' | 'agent';
}

export interface Conversation {
  id: string;
  tenantId: string;
  target: { kind: 'change-request' | 'issue' | 'review-thread'; nativeId: string };
  state: 'active' | 'waiting-confirmation' | 'completed' | 'cancelled';
  contextRevisionSha?: string;
  summary: string;
  activeTaskId?: string;
  /** Used to build the provider and CR ref when executing an ActionPlan. */
  repositoryId?: string;
  changeRequestId?: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  actorLogin: string;
  body: string;
  createdAt: string;
}
