import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { insertRevision, upsertChangeRequest } from '@reviewbot/provider-sync';

/**
 * Registers a change request and its current head from the forge's API, through the same upsert webhooks
 * use, so a later webhook for it updates this row rather than adding another.
 */
export function createChangeRequestRegistrar(deps: {
  db: Db;
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}): (input: { tenantId: string; repositoryId: string; number: number; kind: string }) => Promise<string | null> {
  return async ({ tenantId, repositoryId, number, kind }) => {
    if (kind !== 'pull-request' && kind !== 'merge-request') return null;
    let cr;
    try {
      const provider = await deps.buildProvider(repositoryId);
      // The forge reads it by number; nativeId comes back in the result.
      cr = await provider.changes.get({ id: uuidv7(), repositoryId, nativeId: '', number, kind });
    } catch (err) {
      deps.log?.('change request lookup on the forge failed', { repositoryId, number, error: (err as Error)?.message });
      return null;
    }
    const now = new Date(deps.now?.() ?? Date.now());
    const { revision } = cr;
    const { id } = await upsertChangeRequest(
      deps.db,
      { tenantId, repositoryId },
      {
        nativeId: cr.ref.nativeId,
        number,
        kind,
        observedAt: now,
        state: cr.state,
        draft: cr.draft,
        title: cr.title,
        sourceBranch: revision.sourceBranch,
        targetBranch: revision.targetBranch,
        sourceIsFork: cr.trust === 'fork-public' || cr.trust === 'fork-private',
        author: { login: cr.author.login, providerUserId: cr.author.providerUserId, type: cr.author.type },
        reviewers: cr.reviewers.map((r) => ({ providerUserId: r.providerUserId, login: r.login })),
        labels: cr.labels,
      },
      now,
    );
    await insertRevision(
      deps.db,
      { tenantId, changeRequestId: id },
      { baseSha: revision.baseSha, headSha: revision.headSha, sourceBranch: revision.sourceBranch, targetBranch: revision.targetBranch },
      now,
    );
    deps.log?.('change request registered from the forge', { repositoryId, number, changeRequestId: id });
    return id;
  };
}
