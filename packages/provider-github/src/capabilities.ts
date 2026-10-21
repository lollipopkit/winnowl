import type { ChangeRequestCapabilities } from '@reviewbot/domain';
import { capabilities } from '@reviewbot/provider-contracts';

/** What GitHub supports and this adapter implements. */
export function githubCapabilities(): ChangeRequestCapabilities {
  return capabilities({
    inlineComments: true,
    multilineComments: true,
    fileComments: true,
    reviewBatches: true,
    draftReviews: true,
    resolvableThreads: true,
    suggestions: true,
    commitStatuses: true,
    checksApi: true,
    approvals: true,
    requestChanges: true,
    issueComments: true,
    reactions: true,
    pushToSourceBranch: true,
    createChangeRequest: true,
    pipelineLogs: true,
  });
}
