/** Off by default; applies only when enabled (and approved, if approval is required), else stays pending. */
export interface AutoApplyPolicy {
  autoApply: boolean;
  requireAdminApproval?: boolean;
  adminApproved?: boolean;
}

export interface ApplyResult {
  apply: string[];
  heldForApproval: string[];
}

export function resolveAutoApply(suggested: string[], policy: AutoApplyPolicy): ApplyResult {
  if (!policy.autoApply) return { apply: [], heldForApproval: suggested };
  if (policy.requireAdminApproval && !policy.adminApproved) {
    return { apply: [], heldForApproval: suggested };
  }
  return { apply: suggested, heldForApproval: [] };
}
