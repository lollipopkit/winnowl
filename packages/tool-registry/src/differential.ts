import { createHash } from 'node:crypto';
import type { NormalizedDiagnostic } from './types.js';

export type DiffClass = 'new' | 'persisted' | 'moved' | 'resolved';

export interface ClassifiedDiagnostic extends NormalizedDiagnostic {
  diffClass: DiffClass;
}

/** Line-independent so moved diagnostics still match between base and head. */
export function diagnosticFingerprint(d: NormalizedDiagnostic): string {
  const normalizedMessage = d.message.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update(`${d.toolId}\0${d.ruleId ?? ''}\0${d.path ?? ''}\0${normalizedMessage}`)
    .digest('hex')
    .slice(0, 16);
}

export interface DifferentialResult {
  classified: ClassifiedDiagnostic[];
  /** In base only. */
  resolved: NormalizedDiagnostic[];
}

/** Only new diagnostics become candidates by default. */
export function differential(
  base: NormalizedDiagnostic[],
  head: NormalizedDiagnostic[],
): DifferentialResult {
  const baseByFp = new Map<string, NormalizedDiagnostic[]>();
  for (const d of base) {
    const fp = diagnosticFingerprint(d);
    (baseByFp.get(fp) ?? baseByFp.set(fp, []).get(fp)!).push(d);
  }

  const classified: ClassifiedDiagnostic[] = head.map((h) => {
    const matches = baseByFp.get(diagnosticFingerprint(h));
    if (!matches || matches.length === 0) return { ...h, diffClass: 'new' };
    const sameLine = matches.some((b) => b.line === h.line);
    return { ...h, diffClass: sameLine ? 'persisted' : 'moved' };
  });

  const headFps = new Set(head.map(diagnosticFingerprint));
  const resolved = base.filter((b) => !headFps.has(diagnosticFingerprint(b)));

  return { classified, resolved };
}

export function newDiagnostics(result: DifferentialResult): ClassifiedDiagnostic[] {
  return result.classified.filter((d) => d.diffClass === 'new');
}
