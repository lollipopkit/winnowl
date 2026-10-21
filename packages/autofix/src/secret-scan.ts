/**
 * Blocks delivering a patch whose added lines contain a secret. Curated low-false-positive patterns
 * only, no generic entropy heuristic.
 */
export interface SecretHit {
  kind: string;
  /** Redacted; never the full secret. */
  redactedLine: string;
}

interface SecretPattern {
  kind: string;
  re: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'github-token', re: /\bgh[posur]_[A-Za-z0-9]{36}\b/ },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { kind: 'stripe-secret-key', re: /\bsk_live_[A-Za-z0-9]{24,}\b/ },
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b/ },
];

/** Keeps the first 6 chars, masks the rest, truncates the line to 120. */
function redact(line: string): string {
  const t = line.length > 120 ? `${line.slice(0, 120)}…` : line;
  return t.replace(/[A-Za-z0-9_\-+/=]{12,}/g, (m) => `${m.slice(0, 6)}…[redacted:${m.length}]`);
}

export function scanForSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const line of text.split('\n')) {
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        hits.push({ kind: p.kind, redactedLine: redact(line) });
        break; // one hit per line
      }
    }
  }
  return hits;
}

/** Scans only added lines; removed and context lines are existing code. */
export function scanPatchAdditions(patch: string): SecretHit[] {
  const added: string[] = [];
  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      added.push(raw.slice(1));
    }
  }
  return scanForSecrets(added.join('\n'));
}
