import type { InteractionIntent, ParsedIntent } from './types.js';

interface Rule {
  prefix: string;
  intent: InteractionIntent;
  captureArg?: boolean;
}

// Order matters: more specific prefixes first (full review before review, fix all before fix).
const RULES: Rule[] = [
  { prefix: 'full review', intent: 'full-review' },
  { prefix: 'review', intent: 'review' },
  { prefix: 'explain', intent: 'explain-finding', captureArg: true },
  { prefix: 'verify', intent: 'reverify', captureArg: true },
  { prefix: 'challenge', intent: 'challenge-finding', captureArg: true },
  { prefix: 'run ', intent: 'run-command', captureArg: true },
  // ignore/pause/resume change the gate or triggers: write actions, so explicit commands only.
  { prefix: 'unignore', intent: 'unignore-finding' },
  // 'ignore pr' must precede 'ignore' (RULES match with startsWith).
  { prefix: 'ignore pr', intent: 'ignore-pr' },
  { prefix: 'ignore', intent: 'ignore-finding' },
  { prefix: 'pause', intent: 'pause-reviews' },
  { prefix: 'resume', intent: 'resume-reviews' },
  { prefix: 'fix all', intent: 'fix-all', captureArg: true },
  { prefix: 'fix', intent: 'fix-finding', captureArg: true },
  { prefix: 'generate tests', intent: 'generate-tests', captureArg: true },
  { prefix: 'generate docs', intent: 'generate-docs', captureArg: true },
  { prefix: 'generate diagram', intent: 'generate-diagram', captureArg: true },
  { prefix: 'simplify', intent: 'simplify', captureArg: true },
  { prefix: 'resolve conflict', intent: 'resolve-conflict', captureArg: true },
  // After 'resolve conflict': a finding is fixed or not a problem; the verifier decides.
  { prefix: 'resolve', intent: 'resolve-finding', captureArg: true },
  { prefix: 'add comments', intent: 'add-comments', captureArg: true },
  { prefix: 'create issue', intent: 'create-issue', captureArg: true },
  { prefix: 'implement', intent: 'implement-issue', captureArg: true },
  { prefix: 'plan', intent: 'plan-issue', captureArg: true },
  { prefix: 'show config', intent: 'show-config' },
  { prefix: 'propose learning', intent: 'propose-learning', captureArg: true },
  // Before the `approve` alias (plans): RULES are matched first.
  { prefix: 'approve learning', intent: 'approve-learning', captureArg: true },
  // `@bot feedback false-positive`: the argument is the FeedbackClass.
  { prefix: 'feedback', intent: 'feedback', captureArg: true },
  { prefix: 'help', intent: 'help' },
];

/**
 * Aliases map only to existing intents. Matched as whole words, not with startsWith, so short
 * aliases cannot swallow other commands (`r` vs `run`/`resolve`).
 */
const ALIASES: readonly Rule[] = [
  { prefix: 'r', intent: 'review' },
  { prefix: 'rev', intent: 'review' },
  { prefix: 'fr', intent: 'full-review' },
  { prefix: 'reverify', intent: 'reverify', captureArg: true },
  { prefix: 'rv', intent: 'reverify', captureArg: true },
  { prefix: 'why', intent: 'explain-finding', captureArg: true },
  { prefix: 'dispute', intent: 'challenge-finding', captureArg: true },
  { prefix: 'f', intent: 'fix-finding', captureArg: true },
  { prefix: 'fixall', intent: 'fix-all', captureArg: true },
  { prefix: 'fa', intent: 'fix-all', captureArg: true },
  { prefix: 'diagram', intent: 'generate-diagram', captureArg: true },
  { prefix: 'gd', intent: 'generate-diagram', captureArg: true },
  { prefix: 'tests', intent: 'generate-tests', captureArg: true },
  { prefix: 'gt', intent: 'generate-tests', captureArg: true },
  { prefix: 'docs', intent: 'generate-docs', captureArg: true },
  { prefix: 'comments', intent: 'add-comments', captureArg: true },
  { prefix: 'ac', intent: 'add-comments', captureArg: true },
  { prefix: 'issue', intent: 'create-issue', captureArg: true },
  { prefix: 'impl', intent: 'implement-issue', captureArg: true },
  { prefix: 'config', intent: 'show-config' },
  { prefix: 'cfg', intent: 'show-config' },
  { prefix: 'unpause', intent: 'resume-reviews' },
  // Approves a pending action plan of this conversation (`approve` alone: the newest one the
  // commenter asked for; `approve <plan id or its first characters>`: that one). Here, not in
  // RULES: a write action needs the whole word (`approved` / `approves` must not trigger it).
  { prefix: 'approve', intent: 'approve-plan', captureArg: true },
];

/** A mention that is not a command is what makes classification worth paying for. */
export function hasMention(text: string, botName: string): boolean {
  return text.toLowerCase().includes(`@${botName.toLowerCase()}`);
}

/** Requires an @mention by default; null means "not a command" (left to the classifier). */
export function parseCommand(
  text: string,
  botName: string,
  options: { requireMention?: boolean } = {},
): ParsedIntent | null {
  const requireMention = options.requireMention ?? true;
  const mention = `@${botName.toLowerCase()}`;
  const lowerText = text.toLowerCase();
  const mentionIdx = lowerText.indexOf(mention);

  let rest: string;
  if (mentionIdx >= 0) {
    rest = text.slice(mentionIdx + mention.length).trim();
  } else if (requireMention) {
    return null;
  } else {
    rest = text.trim();
  }

  const lowerRest = rest.toLowerCase();
  for (const rule of RULES) {
    if (lowerRest === rule.prefix || lowerRest.startsWith(`${rule.prefix} `) || lowerRest.startsWith(rule.prefix)) {
      if (rule.captureArg) {
        const arg = rest.slice(rule.prefix.length).trim();
        return { intent: rule.intent, source: 'command', ...(arg ? { argument: arg } : {}) };
      }
      return { intent: rule.intent, source: 'command' };
    }
  }
  // Aliases after main commands: main commands always win.
  for (const rule of ALIASES) {
    if (lowerRest === rule.prefix || lowerRest.startsWith(`${rule.prefix} `)) {
      if (rule.captureArg) {
        const arg = rest.slice(rule.prefix.length).trim();
        return { intent: rule.intent, source: 'command', ...(arg ? { argument: arg } : {}) };
      }
      return { intent: rule.intent, source: 'command' };
    }
  }
  return null;
}

/**
 * Intents without write side effects: the only ones a bot-authored comment may trigger, and the only ones the
 * conversation agent runs after reading repository content. An allowlist, so a new intent is blocked until added here.
 */
const READ_ONLY_INTENTS: ReadonlySet<InteractionIntent> = new Set([
  'review',
  'full-review',
  'explain-finding',
  'reverify',
  'challenge-finding',
  // Like challenge: the verifier decides, the comment alone never resolves it.
  'resolve-finding',
  'plan-issue',
  'show-config',
  'feedback',
  'help',
]);

export function isReadOnlyIntent(intent: InteractionIntent): boolean {
  return READ_ONLY_INTENTS.has(intent);
}

/** Intents that must be rebuilt when the head moves; pure explanations may continue. */
const REBUILD_INTENTS: ReadonlySet<InteractionIntent> = new Set([
  'review',
  'full-review',
  'fix-finding',
  'fix-all',
  'generate-tests',
  'generate-docs',
  'generate-diagram',
  'simplify',
  'resolve-conflict',
  'add-comments',
  'reverify',
]);

export function requiresRebuildOnHeadChange(intent: InteractionIntent): boolean {
  return REBUILD_INTENTS.has(intent);
}
