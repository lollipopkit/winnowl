// Single source of the bot identity, so the self-trigger guard and command parsing never diverge.

export function botName(): string {
  return process.env.BOT_NAME ?? 'winnowl';
}

export function botMention(): string {
  return `@${botName()}`;
}

/** GitHub App comments are authored by `<app-slug>[bot]`; other forges use the plain account name. */
function normalizeLogin(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, '');
}

/**
 * Self-trigger guard: our own comments contain valid commands (e.g. `@winnowl fix`) and forges
 * deliver them back. Matches by login only, since GitLab/Forgejo have no bot user type.
 */
export function isOwnBotLogin(login: string): boolean {
  return normalizeLogin(login) === normalizeLogin(botName());
}

/** Any bot: GitHub's `user.type=Bot`, else the `<name>[bot]` naming convention. */
export function isBotActor(actor: { login: string; type?: string }): boolean {
  return actor.type === 'bot' || /\[bot\]$/i.test(actor.login.trim());
}
