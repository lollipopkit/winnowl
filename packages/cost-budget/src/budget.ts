import { computeRiskFactor } from './risk.js';
import type { AdaptInput, BudgetConsumption, ReviewBudget } from './types.js';

export const DEFAULT_BUDGET: ReviewBudget = {
  maxWallTimeSeconds: 900,
  maxAgentInvocations: 40,
  maxModelInputTokens: 2_000_000,
  maxModelOutputTokens: 400_000,
  maxToolCpuSeconds: 600,
  maxSandboxCommands: 200,
  maxArtifactsBytes: 200 * 1024 * 1024,
  maxScopes: 24,
};

export function adaptBudget(base: ReviewBudget, input: AdaptInput): ReviewBudget {
  return scaleBudget(base, computeRiskFactor(input));
}

function scaleBudget(b: ReviewBudget, factor: number): ReviewBudget {
  const s = (n: number): number => Math.max(1, Math.round(n * factor));
  return {
    maxWallTimeSeconds: s(b.maxWallTimeSeconds),
    maxAgentInvocations: s(b.maxAgentInvocations),
    maxModelInputTokens: s(b.maxModelInputTokens),
    maxModelOutputTokens: s(b.maxModelOutputTokens),
    maxToolCpuSeconds: s(b.maxToolCpuSeconds),
    maxSandboxCommands: s(b.maxSandboxCommands),
    maxArtifactsBytes: s(b.maxArtifactsBytes),
    maxScopes: s(b.maxScopes),
  };
}

/** Lists the exceeded limits. */
export function budgetExceeded(
  budget: ReviewBudget,
  used: BudgetConsumption,
): { exceeded: boolean; violations: string[] } {
  const violations: string[] = [];
  const check = (name: string, u: number, max: number): void => {
    if (u > max) violations.push(`${name}: ${u} > ${max}`);
  };
  check('wallTimeSeconds', used.wallTimeSeconds, budget.maxWallTimeSeconds);
  check('agentInvocations', used.agentInvocations, budget.maxAgentInvocations);
  check('modelInputTokens', used.modelInputTokens, budget.maxModelInputTokens);
  check('modelOutputTokens', used.modelOutputTokens, budget.maxModelOutputTokens);
  check('toolCpuSeconds', used.toolCpuSeconds, budget.maxToolCpuSeconds);
  check('sandboxCommands', used.sandboxCommands, budget.maxSandboxCommands);
  check('artifactsBytes', used.artifactsBytes, budget.maxArtifactsBytes);
  check('scopes', used.scopes, budget.maxScopes);
  return { exceeded: violations.length > 0, violations };
}
