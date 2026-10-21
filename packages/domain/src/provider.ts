import type { ProviderNativeId, Uuid } from './ids.js';

export type ProviderKind = 'github' | 'gitlab' | 'forgejo' | 'bitbucket' | 'azure-devops';

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  'github',
  'gitlab',
  'forgejo',
  'bitbucket',
  'azure-devops',
];

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Read-only ref in the target repo that exposes a change request's head. Fork PR heads are on
 * no target-repo branch, so fetching this ref is required. `undefined` = no known convention.
 */
export function changeRequestHeadRef(provider: ProviderKind, number: number): string | undefined {
  switch (provider) {
    // Forgejo/Gitea use GitHub's naming.
    case 'github':
    case 'forgejo': {
      return `refs/pull/${number}/head`;
    }
    case 'gitlab': {
      return `refs/merge-requests/${number}/head`;
    }
    // TODO: add bitbucket / azure-devops refs together with their adapters; do not guess.
    default: {
      return undefined;
    }
  }
}

/** Provider host (SaaS or self-hosted instance). */
export interface ProviderHostRef {
  id: Uuid;
  provider: ProviderKind;
  baseUrl: string;
  apiUrl: string;
  isSaas: boolean;
}

/** Negotiated capabilities; core logic must branch on these, never assume GitHub features. */
export interface ChangeRequestCapabilities {
  inlineComments: boolean;
  multilineComments: boolean;
  fileComments: boolean;
  reviewBatches: boolean;
  draftReviews: boolean;
  resolvableThreads: boolean;
  suggestions: boolean;
  commitStatuses: boolean;
  checksApi: boolean;
  approvals: boolean;
  requestChanges: boolean;
  issueComments: boolean;
  reactions: boolean;
  pushToSourceBranch: boolean;
  createChangeRequest: boolean;
  pipelineLogs: boolean;
}

export const CHANGE_REQUEST_CAPABILITY_KEYS: readonly (keyof ChangeRequestCapabilities)[] = [
  'inlineComments',
  'multilineComments',
  'fileComments',
  'reviewBatches',
  'draftReviews',
  'resolvableThreads',
  'suggestions',
  'commitStatuses',
  'checksApi',
  'approvals',
  'requestChanges',
  'issueComments',
  'reactions',
  'pushToSourceBranch',
  'createChangeRequest',
  'pipelineLogs',
];

export interface ProviderNativeRef {
  providerHostId: Uuid;
  nativeId: ProviderNativeId;
}
