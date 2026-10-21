import type { DiagnosticSeverity, NormalizedDiagnostic } from './types.js';

/** Unrecognized failure lines are kept as location-less diagnostics. */

interface Matcher {
  tool: string;
  pattern: RegExp;
  build: (m: RegExpExecArray) => NormalizedDiagnostic;
}

function sev(raw: string): DiagnosticSeverity {
  const s = raw.toLowerCase();
  if (s.startsWith('warn')) return 'warning';
  if (s === 'info' || s === 'note') return 'info';
  return 'error';
}

const MATCHERS: Matcher[] = [
  // tsc: path/file.ts(12,5): error TS2345: message
  {
    tool: 'tsc',
    pattern: /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/,
    build: (m) => ({ file: m[1]!, line: Number(m[2]), column: Number(m[3]), severity: sev(m[4]!), message: m[5]!.trim(), tool: 'tsc' }),
  },
  // go: ./pkg/file.go:12:5: message (more specific than the generic pattern, so first)
  {
    tool: 'go',
    pattern: /^(.+\.go):(\d+):(\d+):\s+(.+)$/,
    build: (m) => ({ file: m[1]!, line: Number(m[2]), column: Number(m[3]), severity: 'error', message: m[4]!.trim(), tool: 'go' }),
  },
  // python traceback frame:   File "app.py", line 12, in fn
  {
    tool: 'python',
    pattern: /^\s*File "(.+?)", line (\d+)/,
    build: (m) => ({ file: m[1]!, line: Number(m[2]), severity: 'error', message: 'traceback frame', tool: 'python' }),
  },
  // eslint/generic: path:12:5: message or path:12: message; most general, so last
  {
    tool: 'eslint',
    pattern: /^(.+?):(\d+)(?::(\d+))?:\s+(error|warning)?\s*(.+)$/,
    build: (m) => ({ file: m[1]!, line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}), severity: sev(m[4] ?? 'error'), message: m[5]!.trim(), tool: 'eslint' }),
  },
];

const FAILURE_HINT = /\b(FAIL(ED)?|Error:|Exception|assert(ionError)?|panic:|npm ERR!)\b/i;

export function normalizeDiagnostics(logText: string): NormalizedDiagnostic[] {
  const out: NormalizedDiagnostic[] = [];
  const seen = new Set<string>();
  for (const rawLine of logText.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    let matched = false;
    for (const matcher of MATCHERS) {
      const m = matcher.pattern.exec(line);
      if (m) {
        const diag = matcher.build(m);
        const key = `${diag.tool}:${diag.file ?? ''}:${diag.line ?? ''}:${diag.message}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(diag);
        }
        matched = true;
        break;
      }
    }
    if (!matched && FAILURE_HINT.test(line)) {
      const message = line.trim().slice(0, 300);
      const key = `hint::${message}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ severity: 'error', message });
      }
    }
  }
  return out;
}
