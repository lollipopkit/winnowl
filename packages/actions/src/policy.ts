import { ACTION_RISK, type ActionType } from './types.js';

export interface PolicyDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  requiresAdmin: boolean;
  reasons: string[];
}

/** Configurable on top of the hard-coded safety floor. */
export interface ActionRepoPolicy {
  /**
   * `requireConfirmation=false` is a repository-level pre-approval (only admins can change the config).
   * The safety floor still holds: only bot-namespaced stacked branches, never merge/approve.
   */
  autofix?: { enabled: boolean; requireConfirmation?: boolean };
  createIssue?: { enabled: boolean; requireConfirmation: boolean };
  /** approve/request-changes; default false. */
  mergeGovernanceEnabled?: boolean;
}

export interface PolicyContext {
  action: ActionType;
  actorIsRepoAdmin: boolean;
  repoPolicy?: ActionRepoPolicy;
}

/**
 * Precedence: global safety > tenant > org > repo > path > user. User messages never reach this
 * function, so they cannot override the safety floor (merge never; approve off; branch-write confirmed).
 */
export function evaluatePolicy(context: PolicyContext): PolicyDecision {
  const { action, repoPolicy } = context;
  const risk = ACTION_RISK[action];

  // Safety floor: hard-coded, cannot be relaxed by repo or user.
  if (action === 'merge') {
    return { allowed: false, requiresConfirmation: false, requiresAdmin: false, reasons: ['auto-merge disabled (safety floor)'] };
  }
  if (action === 'approve' || action === 'request-changes') {
    if (!repoPolicy?.mergeGovernanceEnabled) {
      return { allowed: false, requiresConfirmation: false, requiresAdmin: false, reasons: ['merge governance disabled by default'] };
    }
    return { allowed: true, requiresConfirmation: true, requiresAdmin: true, reasons: ['merge governance enabled by repository'] };
  }
  if (action === 'approve-learning') {
    return { allowed: true, requiresConfirmation: false, requiresAdmin: true, reasons: ['only repository admin may approve learnings'] };
  }

  switch (risk) {
    case 'read-only':
      return { allowed: true, requiresConfirmation: false, requiresAdmin: false, reasons: [] };
    case 'comment-only':
      return { allowed: true, requiresConfirmation: false, requiresAdmin: false, reasons: [] };
    case 'metadata-write': {
      if (action === 'create-issue') {
        const cfg = repoPolicy?.createIssue;
        if (!cfg?.enabled) {
          return { allowed: false, requiresConfirmation: false, requiresAdmin: false, reasons: ['issue creation disabled'] };
        }
        return { allowed: true, requiresConfirmation: cfg.requireConfirmation, requiresAdmin: false, reasons: [] };
      }
      return { allowed: true, requiresConfirmation: false, requiresAdmin: false, reasons: [] };
    }
    case 'branch-write': {
      if (repoPolicy?.autofix?.enabled === false) {
        return {
          allowed: false,
          requiresConfirmation: false,
          requiresAdmin: false,
          reasons: ['autofix disabled'],
        };
      }
      // Never writes the CR's source branch; confirmation unless the repository pre-approved it.
      const requiresConfirmation = repoPolicy?.autofix?.requireConfirmation ?? true;
      return {
        allowed: true,
        requiresConfirmation,
        requiresAdmin: false,
        reasons: [requiresConfirmation ? 'branch write requires confirmation' : 'branch write pre-authorized by repository config'],
      };
    }
    case 'merge-governance':
      return { allowed: false, requiresConfirmation: false, requiresAdmin: false, reasons: ['merge governance disabled'] };
  }
}
