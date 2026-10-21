import type { BudgetConsumption, CostRates } from './types.js';

export interface CostBreakdown {
  modelInput: number;
  modelOutput: number;
  toolCpu: number;
  sandbox: number;
  total: number;
}

export function computeCostPerReview(used: BudgetConsumption, rates: CostRates): CostBreakdown {
  const modelInput = (used.modelInputTokens / 1_000_000) * rates.inputPerMillionTokens;
  const modelOutput = (used.modelOutputTokens / 1_000_000) * rates.outputPerMillionTokens;
  const toolCpu = used.toolCpuSeconds * rates.toolCpuSecond;
  const sandbox = used.sandboxCommands * rates.sandboxCommand;
  const total = modelInput + modelOutput + toolCpu + sandbox;
  return { modelInput, modelOutput, toolCpu, sandbox, total };
}
