import { describe, expect, it } from 'vitest';
import { apiBaseUrl, consoleBaseUrl, githubWebhookUrl } from '../src/index.js';

describe('public urls', () => {
  it('derives the webhook URL from API_BASE_URL', () => {
    const env = { CONSOLE_BASE_URL: 'https://console.test/', API_BASE_URL: 'https://api.test//' };
    expect(consoleBaseUrl(env)).toBe('https://console.test');
    expect(apiBaseUrl(env)).toBe('https://api.test');
    expect(githubWebhookUrl(env)).toBe('https://api.test/webhooks/github');
  });

  it('falls back to the console origin when the API shares it', () => {
    expect(githubWebhookUrl({ CONSOLE_BASE_URL: 'https://one.test' })).toBe('https://one.test/webhooks/github');
  });

  it('knows nothing without either address', () => {
    expect(apiBaseUrl({})).toBeUndefined();
    expect(githubWebhookUrl({})).toBeUndefined();
  });
});
