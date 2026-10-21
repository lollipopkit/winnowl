import type { FixDelivery, ValidationStatus } from './types.js';

export interface DeliveryDecision {
  delivery: FixDelivery;
  /** Repo config forbids every delivery form; the caller must abort and report why. */
  blockedByPolicy: boolean;
  validationFailed: boolean;
  /** Only when validation fully passed. */
  resolveFinding: boolean;
  /** Always false: never mark ready-for-merge. */
  readyForMerge: false;
  /** Always false: never auto-approve (safety floor). */
  requestApprove: false;
  titleMarker?: string;
  bodyNotes: string[];
}

export interface DeliveryInput {
  status: ValidationStatus;
  /** Without confirmed branch-write only an artifact can be delivered. */
  branchWriteConfirmed: boolean;
  failedCommands: string[];
  residualRisks: string[];
  /** `actions.autofix.delivery`; omitted = both allowed. */
  allowedDeliveries?: readonly FixDelivery[];
}

/**
 * Falls back to an artifact when branch-write is unconfirmed or disallowed; `blockedByPolicy` when
 * no form is allowed. Failed validation marks title/body and never resolves, readies or approves.
 */
export function decideDelivery(input: DeliveryInput): DeliveryDecision {
  const validationFailed = input.status !== 'passed';
  const preferred: FixDelivery = input.branchWriteConfirmed ? 'stacked-change-request' : 'artifact';
  const permits = (d: FixDelivery): boolean => input.allowedDeliveries === undefined || input.allowedDeliveries.includes(d);

  const bodyNotes: string[] = [];
  let delivery = preferred;
  let blockedByPolicy = false;
  if (!permits(preferred)) {
    if (permits('artifact')) {
      delivery = 'artifact';
      bodyNotes.push('Stacked change request delivery is disabled by repository config; delivered as patch artifact.');
    } else {
      // Both forms disabled: the caller aborts and `delivery` is meaningless.
      delivery = 'artifact';
      blockedByPolicy = true;
    }
  }

  if (validationFailed) {
    if (input.status === 'not-run') {
      bodyNotes.push('Validation not run.');
    } else {
      bodyNotes.push(`Validation failed. Failed commands: ${input.failedCommands.join('; ') || '(none captured)'}`);
    }
  }
  for (const risk of input.residualRisks) bodyNotes.push(`Residual risk: ${risk}`);

  return {
    delivery,
    blockedByPolicy,
    validationFailed,
    resolveFinding: input.status === 'passed',
    readyForMerge: false,
    requestApprove: false,
    ...(validationFailed ? { titleMarker: 'Validation failed' } : {}),
    bodyNotes,
  };
}
