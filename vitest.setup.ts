import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Loads the root .env for live tests; expands `${VAR}` / `$VAR` from the shell, and exported shell
 * variables win. Same logic as apps/runner-supervisor/src/env.ts.
 */
function loadEnv(path = '.env'): void {
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
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    let expand = true;
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
      expand = false; // single quotes: literal, like the shell
    } else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (expand) {
      value = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => process.env[a ?? b] ?? '');
    }
    process.env[key] = value;
  }
}

loadEnv();
