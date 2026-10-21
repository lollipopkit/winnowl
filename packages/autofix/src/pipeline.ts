import type { ArtifactRef } from '@reviewbot/artifacts';
import type { SandboxBackend, SandboxHandle, SandboxSpec } from '@reviewbot/sandbox';
import { stackedBranchName, stackedIdempotencyKey } from './branch.js';
import { decideDelivery, type DeliveryDecision } from './delivery.js';
import type { FixDelivery, FixPlan, FixResult } from './types.js';
import { computeValidationStatus, failedCommands, toValidationResult } from './validation.js';

export interface ProducedFix {
  /** Unified diff. */
  patch: string;
  modifiedFiles: string[];
  residualRisks: string[];
  confidence: number;
}

export interface FixAgentContext {
  handle: SandboxHandle;
  backend: SandboxBackend;
  plan: FixPlan;
}

export interface RunFixPipelineInput {
  plan: FixPlan;
  backend: SandboxBackend;
  spec: SandboxSpec;
  produceFix: (ctx: FixAgentContext) => Promise<ProducedFix>;
  storePatch: (patch: string) => Promise<ArtifactRef>;
  /** Whether the policy engine confirmed branch-write. */
  branchWriteConfirmed: boolean;
  changeNumber: string | number;
  actionId: string;
  baseHeadSha: string;
  /** `actions.autofix.delivery`; omitted = both allowed. */
  allowedDeliveries?: readonly FixDelivery[];
}

export interface FixPipelineOutcome {
  result: FixResult;
  delivery: DeliveryDecision;
  stacked?: { branch: string; idempotencyKey: string };
}

/** A failed validation is marked and never resolves findings, marks ready or approves. */
export async function runFixPipeline(input: RunFixPipelineInput): Promise<FixPipelineOutcome> {
  const { plan, backend, spec } = input;
  const handle = await backend.create(spec);
  try {
    const produced = await input.produceFix({ handle, backend, plan });

    const validation = [];
    for (const req of plan.validationCommands) {
      const res = await backend.exec(handle, req);
      validation.push(toValidationResult(req, res));
    }
    const validationStatus = computeValidationStatus(validation);

    const patchArtifact = await input.storePatch(produced.patch);

    const delivery = decideDelivery({
      status: validationStatus,
      branchWriteConfirmed: input.branchWriteConfirmed,
      failedCommands: failedCommands(validation),
      residualRisks: produced.residualRisks,
      ...(input.allowedDeliveries !== undefined ? { allowedDeliveries: input.allowedDeliveries } : {}),
    });

    const result: FixResult = {
      findingIds: plan.findingIds,
      patchArtifact,
      modifiedFiles: produced.modifiedFiles,
      validation,
      residualRisks: produced.residualRisks,
      confidence: produced.confidence,
      validationStatus,
      delivery: delivery.delivery,
    };

    const outcome: FixPipelineOutcome = { result, delivery };
    if (delivery.delivery === 'stacked-change-request') {
      outcome.stacked = {
        branch: stackedBranchName(input.changeNumber, input.actionId),
        idempotencyKey: stackedIdempotencyKey({
          baseHeadSha: input.baseHeadSha,
          findingIds: plan.findingIds,
          kind: plan.kind,
        }),
      };
    }
    return outcome;
  } finally {
    await backend.destroy(handle);
  }
}
