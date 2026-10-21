/**
 * Public addresses, all derived from `CONSOLE_BASE_URL` and `API_BASE_URL` (omitted when the API
 * shares the console origin) so no copy goes stale. Never inferred from request headers.
 */
type Env = Record<string, string | undefined>;

const trimSlash = (raw: string): string => raw.replace(/\/+$/, '');

export function consoleBaseUrl(env: Env): string | undefined {
  return env.CONSOLE_BASE_URL ? trimSlash(env.CONSOLE_BASE_URL) : undefined;
}

export function apiBaseUrl(env: Env): string | undefined {
  return env.API_BASE_URL ? trimSlash(env.API_BASE_URL) : consoleBaseUrl(env);
}

/** The URL the GitHub App must deliver webhooks to (webhook-ingress `POST /webhooks/github`). */
export function githubWebhookUrl(env: Env): string | undefined {
  const api = apiBaseUrl(env);
  return api ? `${api}/webhooks/github` : undefined;
}
