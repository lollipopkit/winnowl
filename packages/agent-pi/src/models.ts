import { getModel } from '@earendil-works/pi-ai/compat';
import type { Model } from '@earendil-works/pi-ai';
import type { ModelPolicy } from './types.js';

// compat.getModel only accepts built-in provider literals; ModelPolicy uses arbitrary strings.
const getModelDynamic = getModel as unknown as (
  provider: string,
  modelId: string,
) => Model<string> | undefined;

export function resolveModel(policy: ModelPolicy): Model<string> {
  const model = getModelDynamic(policy.provider, policy.modelId);
  if (!model) {
    throw new Error(`unknown model: ${policy.provider}/${policy.modelId}`);
  }
  return model;
}
