import type { ChangeRequestCapabilities } from '@reviewbot/domain';
import { capabilities } from '@reviewbot/provider-contracts';

/** Conservative defaults (vary by instance version): no Checks API, limited thread resolution. */
export function forgejoCapabilities(): ChangeRequestCapabilities {
  return capabilities({
    inlineComments: true,
    multilineComments: false,
    fileComments: false,
    reviewBatches: false,
    draftReviews: false,
    resolvableThreads: false,
    suggestions: false,
    commitStatuses: true,
    checksApi: false,
    approvals: true,
    requestChanges: true,
    issueComments: true,
    reactions: true,
    pushToSourceBranch: true,
    createChangeRequest: true,
    pipelineLogs: false,
  });
}
