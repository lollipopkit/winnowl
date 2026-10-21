export type ActionRisk =
  | 'read-only'
  | 'comment-only'
  | 'metadata-write'
  | 'branch-write'
  | 'merge-governance';

export type ActionType =
  | 'explain'
  | 'search'
  | 'reverify'
  | 'run-command'
  | 'inspect-code'
  | 'show-config'
  | 'reply'
  | 'generate-patch-artifact'
  | 'generate-tests'
  | 'generate-docs'
  | 'simplify'
  | 'resolve-conflict'
  | 'create-issue'
  | 'plan-issue'
  | 'propose-learning'
  | 'approve-learning'
  | 'create-stacked-pr'
  | 'create-cr-from-issue'
  | 'approve'
  | 'request-changes'
  | 'merge';

export const ACTION_RISK: Record<ActionType, ActionRisk> = {
  explain: 'read-only',
  search: 'read-only',
  reverify: 'read-only',
  'run-command': 'read-only',
  'inspect-code': 'read-only',
  'show-config': 'read-only',
  reply: 'comment-only',
  'generate-patch-artifact': 'read-only',
  'generate-tests': 'read-only',
  'generate-docs': 'read-only',
  simplify: 'read-only',
  'resolve-conflict': 'read-only',
  'create-issue': 'metadata-write',
  'plan-issue': 'read-only',
  'propose-learning': 'metadata-write',
  'approve-learning': 'metadata-write',
  'create-stacked-pr': 'branch-write',
  'create-cr-from-issue': 'branch-write',
  approve: 'merge-governance',
  'request-changes': 'merge-governance',
  merge: 'merge-governance',
};
