export type ToolCategory =
  | 'compiler'
  | 'typecheck'
  | 'linter'
  | 'static-analysis'
  | 'sast'
  | 'dependency'
  | 'secrets'
  | 'test'
  | 'coverage'
  | 'format'
  | 'custom';

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'style';

export interface NormalizedDiagnostic {
  toolId: string;
  ruleId?: string;
  severity: DiagnosticSeverity;
  message: string;
  path?: string;
  line?: number;
}

export interface ProjectContext {
  languages: string[];
  commands: {
    build: string[];
    lint: string[];
    test: string[];
  };
}
