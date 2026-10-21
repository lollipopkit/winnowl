import type { FactEcosystem } from './fact-ecosystems.js';

/**
 * Version awareness for ecosystem facts: which version of a dependency the repository actually
 * uses, and whether a fact's free-text `versions` range covers it.
 *
 * Both answers can be "unknown" (`undefined`) and callers must treat unknown as "keep the fact":
 * dropping a fact is only right when the version is known AND the range is understood AND they
 * do not overlap. Nothing here guesses.
 */

export interface DependencyFile {
  path: string;
  text: string;
}

type Eco = Exclude<FactEcosystem, 'other'>;

/** Lockfiles by name; they pin the exact resolved version. */
const LOCKFILES: Record<string, Eco> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'npm',
  'yarn.lock': 'npm',
  'pubspec.lock': 'pub',
  'Cargo.lock': 'cargo',
  'poetry.lock': 'pypi',
  'uv.lock': 'pypi',
  'composer.lock': 'composer',
  'Gemfile.lock': 'rubygems',
};

export function lockfileEcosystem(fileName: string): Eco | undefined {
  return LOCKFILES[fileName];
}

const baseName = (path: string): string => path.split('/').pop() ?? path;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** PEP 503 name normalisation (pypi treats `-`, `_`, `.` and case as equal). */
const pyName = (s: string): string => s.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * The version of `name` the repository resolves to, from its lockfiles first, then exact pins in
 * manifests. Several different versions (e.g. nested npm copies) → the top-level one when the
 * format says which; otherwise unknown.
 */
export function resolvedVersion(eco: FactEcosystem, name: string, files: readonly DependencyFile[]): string | undefined {
  if (eco === 'other') return undefined;
  const found = new Set<string>();
  for (const f of files) {
    const file = baseName(f.path);
    const v = lockfileEcosystem(file) === eco ? fromLockfile(file, name, f.text) : fromManifest(eco, file, name, f.text);
    if (v) found.add(v);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

function fromLockfile(file: string, name: string, text: string): string | undefined {
  switch (file) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json': {
      try {
        const j = JSON.parse(text) as {
          packages?: Record<string, { version?: string }>;
          dependencies?: Record<string, { version?: string }>;
        };
        return j.packages?.[`node_modules/${name}`]?.version ?? j.dependencies?.[name]?.version;
      } catch {
        return undefined;
      }
    }
    case 'pnpm-lock.yaml': {
      // v6+: `  name@1.2.3:` / `  /name@1.2.3:`; v5: `  /name/1.2.3:` (peer suffixes in parentheses).
      const re = new RegExp(`^ {2}['"]?/?${esc(name)}(?:@|/)(\\d[^:('"\\s]*)`, 'm');
      return re.exec(text)?.[1];
    }
    case 'yarn.lock': {
      // Block header lists the requested ranges, the body has the resolved version.
      const re = new RegExp(`^"?${esc(name)}@[^\\n]*:\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+version:? "?([^"\\n]+)"?`, 'm');
      return re.exec(text)?.[1]?.trim();
    }
    case 'pubspec.lock': {
      const block = new RegExp(`^ {2}${esc(name)}:\\n((?: {4}[^\\n]*\\n?)*)`, 'm').exec(text)?.[1];
      // SDK packages (flutter, flutter_test, …) are pinned as "0.0.0": not a version at all.
      if (!block || /^ {4}source: sdk$/m.test(block)) return undefined;
      return /^ {4}version: "?([^"\n]+)"?/m.exec(block)?.[1];
    }
    case 'Cargo.lock':
    case 'poetry.lock':
    case 'uv.lock': {
      const target = file === 'Cargo.lock' ? name : pyName(name);
      for (const block of text.split(/^\[\[package\]\]$/m)) {
        const n = /^name = "([^"]+)"/m.exec(block)?.[1];
        if (n && (file === 'Cargo.lock' ? n : pyName(n)) === target) return /^version = "([^"]+)"/m.exec(block)?.[1];
      }
      return undefined;
    }
    case 'composer.lock': {
      try {
        const j = JSON.parse(text) as { packages?: { name: string; version: string }[]; 'packages-dev'?: { name: string; version: string }[] };
        const p = [...(j.packages ?? []), ...(j['packages-dev'] ?? [])].find((x) => x.name === name);
        return p?.version.replace(/^v/, '');
      } catch {
        return undefined;
      }
    }
    case 'Gemfile.lock': {
      const re = new RegExp(`^ {4}${esc(name)} \\(([^)\\s]+)\\)`, 'm');
      return re.exec(text)?.[1];
    }
    default:
      return undefined;
  }
}

/** Exact pins written in a manifest (ranges are not versions). */
function fromManifest(eco: Eco, file: string, name: string, text: string): string | undefined {
  if (eco === 'go' && file === 'go.mod') {
    const re = new RegExp(`^\\s*(?:require\\s+)?${esc(name)}\\s+(v\\d[^\\s]*)`, 'm');
    return re.exec(text)?.[1];
  }
  if (eco === 'npm' && file === 'package.json') {
    try {
      const j = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const v = j[k]?.[name];
        if (v && /^\d+\.\d+\.\d+$/.test(v.trim())) return v.trim();
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (eco === 'pub' && file === 'pubspec.yaml') {
    const re = new RegExp(`^\\s+${esc(name)}:\\s*['"]?(\\d+\\.\\d+\\.\\d+)['"]?\\s*$`, 'm');
    return re.exec(text)?.[1];
  }
  if (eco === 'pypi' && file.startsWith('requirements')) {
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*==\s*([0-9][^\s;#]*)/.exec(line);
      if (m && pyName(m[1]!) === pyName(name)) return m[2];
    }
    return undefined;
  }
  if (eco === 'cargo' && file === 'Cargo.toml') {
    const re = new RegExp(`^${esc(name)}\\s*=\\s*(?:"=\\s*(\\d[^"]*)"|\\{[^}\\n]*version\\s*=\\s*"=\\s*(\\d[^"]*)")`, 'm');
    const m = re.exec(text);
    return m?.[1] ?? m?.[2];
  }
  return undefined;
}

/** Dotted numeric version (leading `v`/`=` allowed, pre-release/build suffix ignored). */
export function parseVersion(raw: string): number[] | undefined {
  const m = /^[v=]?\s*(\d+(?:\.\d+)*)/.exec(raw.trim());
  return m ? m[1]!.split('.').map(Number) : undefined;
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

type Check = (v: number[]) => boolean;

/** Upper bound for npm/pub caret: first non-zero component bumps. */
function caretUpper(p: number[]): number[] {
  const i = p.findIndex((x) => x !== 0);
  const at = i === -1 ? p.length - 1 : Math.min(i, p.length - 1);
  return [...p.slice(0, at), p[at]! + 1];
}

/** One comparator token → predicate; unknown syntax → undefined. */
function comparator(tok: string): Check | undefined {
  const m = /^(>=|<=|>|<|==|=|!=|\^|~=|~)?\s*(.+)$/.exec(tok);
  if (!m) return undefined;
  const op = m[1] ?? '';
  const ver = m[2]!.trim();
  if (ver === '*' || /^x$/i.test(ver)) return op === '' ? () => true : undefined;
  // Wildcards: 1.2.x / 1.* / 1.2
  const wild = /^[v=]?(\d+(?:\.\d+)*)(?:\.[x*])+$/i.exec(ver);
  if (wild && (op === '' || op === '=' || op === '==')) {
    const p = wild[1]!.split('.').map(Number);
    return (v) => p.every((x, i) => (v[i] ?? 0) === x);
  }
  const p = parseVersion(ver);
  if (!p || !/^[v=]?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]*)?$/.test(ver)) return undefined;
  switch (op) {
    case '>=':
      return (v) => cmp(v, p) >= 0;
    case '>':
      return (v) => cmp(v, p) > 0;
    case '<=':
      return (v) => cmp(v, p) <= 0;
    case '<':
      return (v) => cmp(v, p) < 0;
    case '!=':
      return (v) => cmp(v, p) !== 0;
    case '^': {
      const hi = caretUpper(p);
      return (v) => cmp(v, p) >= 0 && cmp(v, hi) < 0;
    }
    case '~': {
      const hi = p.length >= 2 ? [p[0]!, p[1]! + 1] : [p[0]! + 1];
      return (v) => cmp(v, p) >= 0 && cmp(v, hi) < 0;
    }
    case '~=': {
      if (p.length < 2) return undefined;
      const hi = [...p.slice(0, -2), p[p.length - 2]! + 1];
      return (v) => cmp(v, p) >= 0 && cmp(v, hi) < 0;
    }
    default:
      // Bare or `=`/`==`: exact on the given precision ("1.2" means 1.2.x).
      return (v) => p.every((x, i) => (v[i] ?? 0) === x);
  }
}

/**
 * Does `version` fall in `range`? Supports `>= > <= < = == !=`, npm/pub `^` and `~`, pypi `~=`,
 * wildcards (`1.2.x`, `1.*`, `*`), `a - b` hyphen ranges, space- or comma-separated AND and `||`
 * OR. Anything else (prose such as "before 2.0") → undefined.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const v = parseVersion(version);
  if (!v) return undefined;
  const alternatives = range.split('||').map((s) => s.trim());
  if (alternatives.some((a) => a === '')) return undefined;
  let any = false;
  for (const alt of alternatives) {
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alt);
    const tokens = hyphen
      ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
      : alt
          .replace(/(>=|<=|>|<|==|=|!=|\^|~=|~)\s+/g, '$1')
          .split(/[\s,]+/)
          .filter(Boolean);
    const checks = tokens.map(comparator);
    if (checks.length === 0 || checks.some((c) => c === undefined)) return undefined;
    if ((checks as Check[]).every((c) => c(v))) any = true;
  }
  return any;
}
