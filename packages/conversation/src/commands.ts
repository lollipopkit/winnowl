import type { InteractionIntent } from './types.js';

/**
 * Every comment command, in the order `help` lists them. One list for `help` and for the conversation agent's
 * command tool, so the agent can run exactly what a person can type. `key` names the localized summary.
 */
export interface CommandSpec {
  key: string;
  /** Typed after the mention, e.g. `fix all`. */
  usage: string;
  intent: InteractionIntent;
  /** For the agent; people read the localized text. */
  summary: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  { key: 'review', usage: 'review', intent: 'review', summary: 'Review the commits added since the last review.' },
  { key: 'fullReview', usage: 'full review', intent: 'full-review', summary: 'Review the whole pull request again.' },
  { key: 'explain', usage: 'explain', intent: 'explain-finding', summary: 'Explain a finding and its evidence (in the finding’s thread, or the most relevant one).' },
  { key: 'verify', usage: 'verify', intent: 'reverify', summary: 'Re-check the findings with a fresh verifier.' },
  { key: 'challenge', usage: 'challenge <reason>', intent: 'challenge-finding', summary: 'Dispute a finding; a fresh verifier judges it again with the reason.' },
  { key: 'resolve', usage: 'resolve <why>', intent: 'resolve-finding', summary: 'Say a finding is fixed or not a problem; a fresh verifier checks before it is resolved.' },
  { key: 'ignore', usage: 'ignore', intent: 'ignore-finding', summary: 'Ignore a finding on this pull request (in its thread); it stops blocking the merge.' },
  { key: 'unignore', usage: 'unignore', intent: 'unignore-finding', summary: 'Undo ignore for a finding, or for the pull request.' },
  { key: 'ignorePr', usage: 'ignore pr', intent: 'ignore-pr', summary: 'Stop reviewing new commits on this pull request.' },
  { key: 'pause', usage: 'pause', intent: 'pause-reviews', summary: 'Pause automatic reviews of this pull request.' },
  { key: 'resume', usage: 'resume', intent: 'resume-reviews', summary: 'Resume automatic reviews of this pull request.' },
  { key: 'fix', usage: 'fix', intent: 'fix-finding', summary: 'Fix a finding in a separate stacked pull request (needs confirmation).' },
  { key: 'fixAll', usage: 'fix all', intent: 'fix-all', summary: 'Fix all open findings in a stacked pull request (needs confirmation).' },
  { key: 'generateTests', usage: 'generate tests', intent: 'generate-tests', summary: 'Write tests for the change in a stacked pull request.' },
  { key: 'generateDocs', usage: 'generate docs', intent: 'generate-docs', summary: 'Write documentation for the change in a stacked pull request.' },
  { key: 'generateDiagram', usage: 'generate diagram', intent: 'generate-diagram', summary: 'Draw a diagram of the change in a stacked pull request.' },
  { key: 'simplify', usage: 'simplify', intent: 'simplify', summary: 'Simplify the changed code in a stacked pull request.' },
  { key: 'resolveConflict', usage: 'resolve conflict', intent: 'resolve-conflict', summary: 'Resolve merge conflicts with the target branch in a stacked pull request.' },
  { key: 'addComments', usage: 'add comments', intent: 'add-comments', summary: 'Add code comments to the change in a stacked pull request.' },
  { key: 'run', usage: 'run <command>', intent: 'run-command', summary: 'Run a shell command in a sandbox on the pull request head and post its output.' },
  { key: 'createIssue', usage: 'create issue <title>', intent: 'create-issue', summary: 'Open an issue from this conversation.' },
  { key: 'plan', usage: 'plan', intent: 'plan-issue', summary: 'Analyze this issue and propose an implementation plan.' },
  { key: 'implement', usage: 'implement', intent: 'implement-issue', summary: 'Implement this issue in a new pull request (needs confirmation).' },
  { key: 'approve', usage: 'approve [plan id]', intent: 'approve-plan', summary: 'Approve the pending action plan you asked for.' },
  { key: 'showConfig', usage: 'show config', intent: 'show-config', summary: 'Show the effective configuration of this repository.' },
  { key: 'proposeLearning', usage: 'propose learning [org|me] <rule>', intent: 'propose-learning', summary: 'Record a rule for later reviews of this repository, the organization (org) or your own pull requests (me).' },
  { key: 'approveLearning', usage: 'approve learning <id>', intent: 'approve-learning', summary: 'Approve a pending learning of this repository.' },
  { key: 'feedback', usage: 'feedback <class>', intent: 'feedback', summary: 'Record how a finding turned out (in its thread); class is one of fixed, accepted, false-positive, not-important, duplicate, already-known, wrong-location, wrong-severity, bad-suggestion.' },
  { key: 'help', usage: 'help', intent: 'help', summary: 'List these commands.' },
];

/** `@bot <usage>`, the form people type. */
export function commandUsage(bot: string, spec: CommandSpec): string {
  return `@${bot} ${spec.usage}`;
}
