export type {
  FixKind,
  FixPlan,
  FixResult,
  FixDelivery,
  ValidationResult,
  ValidationStatus,
} from './types.js';
export { FIX_KINDS } from './types.js';

export { stackedBranchName, stackedIdempotencyKey } from './branch.js';

export {
  toValidationResult,
  computeValidationStatus,
  failedCommands,
} from './validation.js';

export { decideDelivery } from './delivery.js';
export type { DeliveryDecision, DeliveryInput } from './delivery.js';

export { runFixPipeline } from './pipeline.js';
export type {
  RunFixPipelineInput,
  FixPipelineOutcome,
  ProducedFix,
  FixAgentContext,
} from './pipeline.js';

export { createAgentFixProducer } from './agent-fix.js';
export type { AgentFixProducerDeps } from './agent-fix.js';

export { detectValidationCommands } from './detect-validation.js';
export { resolveValidationCommands } from './validation-commands.js';
export type { ValidationToolsConfig } from './validation-commands.js';
export { scanForSecrets, scanPatchAdditions } from './secret-scan.js';
export type { SecretHit } from './secret-scan.js';
export { runValidationInSandbox, runTreeValidation } from './sandbox-validate.js';
export type { SandboxValidationInput, SandboxValidationOutcome, TreeValidationInput } from './sandbox-validate.js';

export {
  applyPatchToTree,
  collectTreeChanges,
  deliverStackedChangeRequest,
  safeTreePath,
  sanitizePatch,
  stripWorkflowChanges,
  isStructuredPatch,
  parseStructuredPatch,
  fuzzyReplaceBlock,
} from './deliver-stacked.js';
export type { StructuredFile } from './deliver-stacked.js';
export type {
  StackedDeliveryDeps,
  StackedDeliveryInput,
  StackedDeliveryResult,
  StackedGitResult,
  RunGit,
} from './deliver-stacked.js';
