/** Runs before normalization; over-redaction is preferred to leaking a secret. */

const REDACTED = '[REDACTED]';

interface RedactRule {
  name: string;
  pattern: RegExp;
  /** Keep capture group 1 (e.g. `KEY=`) and replace the rest. */
  keepPrefix?: boolean;
}

const RULES: RedactRule[] = [
  // PEM private key block
  { name: 'pem', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // GitHub tokens
  { name: 'github-token', pattern: /\b(gh[posu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  // AWS access key id
  { name: 'aws-akid', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // Slack token
  { name: 'slack', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // JWT
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g },
  // Authorization: Bearer/token/Basic <secret>
  { name: 'auth-header', pattern: /\b(Authorization\s*[:=]\s*(?:Bearer|token|Basic)\s+)\S+/gi, keepPrefix: true },
  // scheme://user:pass@host (lookahead keeps @host)
  { name: 'url-cred', pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi, keepPrefix: true },
  // KEY=VALUE / KEY: VALUE with a sensitive name
  {
    name: 'kv-secret',
    pattern: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[:=]\s*)("?)[^\s"']+\2/gi,
    keepPrefix: true,
  },
];

export interface RedactResult {
  text: string;
  redactedCount: number;
}

export function redactSecrets(text: string): RedactResult {
  let out = text;
  let count = 0;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (_match, prefix?: string) => {
      count += 1;
      return rule.keepPrefix && typeof prefix === 'string' ? `${prefix}${REDACTED}` : REDACTED;
    });
  }
  return { text: out, redactedCount: count };
}
