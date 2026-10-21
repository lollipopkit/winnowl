/** Collapses and trims whitespace for anchor matching. */
export function normalizeLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** FNV-1a 32-bit (non-cryptographic) line identity hash. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const GENERATED_PATTERNS: readonly RegExp[] = [
  /(^|\/)vendor\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /\.min\.(js|css)$/,
  /(^|\/)generated\//,
  /\.generated\./,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)Cargo\.lock$/,
];

/** Heuristic for generated / vendored / minified / lock files. */
export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(path));
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  php: 'php',
  kt: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  sql: 'sql',
  sh: 'shell',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  md: 'markdown',
};

export function detectLanguage(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext ? LANGUAGE_BY_EXT[ext] : undefined;
}
