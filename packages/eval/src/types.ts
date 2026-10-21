/** Kept out of index.ts to avoid an import cycle with the barrel file. */

export type EvalSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface EvalFinding {
  category: string;
  severity: EvalSeverity;
  path: string;
}
