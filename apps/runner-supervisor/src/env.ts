import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Loads .env when present. Expands `${VAR}` / `$VAR` from the shell; exported shell variables win over .env.
 * Mirrors the root vitest.setup.ts (kept duplicated to avoid a build dependency).
 */
export function loadEnv(path = '.env'): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue; // shell wins
    let value = line.slice(eq + 1).trim();
    let expand = true;
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
      expand = false;
    } else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (expand) {
      value = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => process.env[a ?? b] ?? '');
    }
    process.env[key] = value;
  }
}
