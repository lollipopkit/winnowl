import type { ChangeRequestCapabilities } from '@reviewbot/domain';
import { capabilities } from '@reviewbot/provider-contracts';

/** No Checks API (commit status instead) and no batched review events. */
export function gitlabCapabilities(): ChangeRequestCapabilities {
  return capabilities({
    inlineComments: true,
    multilineComments: true,
    fileComments: true,
    reviewBatches: false,
    draftReviews: true,
    resolvableThreads: true,
    suggestions: true,
    commitStatuses: true,
    checksApi: false,
    approvals: true,
    requestChanges: false,
    issueComments: true,
    reactions: true,
    pushToSourceBranch: true,
    createChangeRequest: true,
    pipelineLogs: true,
  });
}
