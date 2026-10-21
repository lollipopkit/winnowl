export interface ReviewBudget {
  maxWallTimeSeconds: number;
  maxAgentInvocations: number;
  maxModelInputTokens: number;
  maxModelOutputTokens: number;
  maxToolCpuSeconds: number;
  maxSandboxCommands: number;
  maxArtifactsBytes: number;
  maxScopes: number;
}

export type HighRiskFactor =
  | 'auth-security'
  | 'concurrency'
  | 'migration'
  | 'public-api'
  | 'large-refactor'
  | 'linked-incident'
  | 'dependency-major-upgrade';

export type LowRiskFactor = 'generated-code' | 'docs';

/** Lives here to avoid a budget <-> risk import cycle. */
export interface AdaptInput {
  highRisk?: HighRiskFactor[];
  lowRisk?: LowRiskFactor[];
}

export interface BudgetConsumption {
  wallTimeSeconds: number;
  agentInvocations: number;
  modelInputTokens: number;
  modelOutputTokens: number;
  toolCpuSeconds: number;
  sandboxCommands: number;
  artifactsBytes: number;
  scopes: number;
}

export interface CostRates {
  /** USD per million tokens. */
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  /** USD. */
  toolCpuSecond: number;
  /** USD, approximate. */
  sandboxCommand: number;
}
