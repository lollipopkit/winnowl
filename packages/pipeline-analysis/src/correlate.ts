import type { NormalizedDiagnostic } from './types.js';

export interface ChangedCode {
  isChangedFile: (path: string) => boolean;
  /** 1-based; without it the check is per file. */
  isChangedLine?: (path: string, line: number) => boolean;
}

export function correlateWithChanges(
  diagnostics: NormalizedDiagnostic[],
  changed: ChangedCode,
): NormalizedDiagnostic[] {
  return diagnostics.map((d) => {
    if (!d.file) return { ...d, onChangedCode: false };
    const fileChanged = changed.isChangedFile(d.file);
    if (!fileChanged) return { ...d, onChangedCode: false };
    if (d.line !== undefined && changed.isChangedLine) {
      return { ...d, onChangedCode: changed.isChangedLine(d.file, d.line) };
    }
    return { ...d, onChangedCode: true };
  });
}
