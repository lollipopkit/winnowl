/**
 * 0-based line that pins `pkg` at `version` in a manifest/lockfile, or -1. The version sits either on
 * the name line (pnpm-lock, Gemfile.lock, go.sum) or later in the package's block (Cargo.lock,
 * package-lock, yarn.lock, ...). Without a version the name line is the pin.
 */
export function locatePinLine(lines: readonly string[], pkg: string, version: string | undefined): number {
  const nameRe = tokenRe(pkg, '[\\w.-]', '[\\w.-]|/(?!\\s)');
  const nameLines = lines.flatMap((l, i) => (nameRe.test(l) ? [i] : []));
  if (!version) return nameLines[0] ?? -1;
  const versionRe = tokenRe(version, '[\\w.]', '[\\w.+-]', 'v?');
  for (const i of nameLines) if (versionRe.test(lines[i]!)) return i;
  for (const i of nameLines) {
    const j = versionLineInBlock(lines, i, versionRe);
    if (j >= 0) return j;
  }
  return -1;
}

/** Longest block worth scanning (pubspec.lock / composer.lock entries run to ~10–20 lines). */
const MAX_BLOCK_LINES = 40;

/** Next package entry inside a flat block (TOML / composer siblings share the name line's indentation). */
const SIBLING_NAME = /^\s*(?:name\s*=|"name"\s*:)/;

function versionLineInBlock(lines: readonly string[], start: number, versionRe: RegExp): number {
  const head = lines[start]!;
  const indent = indentOf(head);
  // A name line that opens a nested block (`pkg:` / `"node_modules/pkg": {`) owns only deeper lines.
  const nested = /[:{]\s*$/.test(head);
  for (let j = start + 1; j < lines.length && j <= start + MAX_BLOCK_LINES; j++) {
    const line = lines[j]!;
    if (!line.trim() || /^\s*\[/.test(line)) return -1;
    const d = indentOf(line);
    if (d < indent || (nested && d === indent) || (!nested && SIBLING_NAME.test(line))) return -1;
    if (versionRe.test(line)) return j;
  }
  return -1;
}

const indentOf = (line: string): number => /^\s*/.exec(line)![0].length;

function tokenRe(token: string, before: string, after: string, prefix = ''): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!${before})${prefix}${escaped}(?!${after})`);
}
