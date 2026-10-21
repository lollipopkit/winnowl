import type { DiscussionApi, DiscussionThreadRef } from '@reviewbot/provider-contracts';

export interface ThreadResolutionContext {
  resolvableThreads: boolean;
  isBotThread: boolean;
}

/** Resolves only threads this bot created whose finding is resolved; never human threads. */
export async function resolveFindingThread(
  discussions: Pick<DiscussionApi, 'resolve'>,
  thread: DiscussionThreadRef,
  context: ThreadResolutionContext,
): Promise<boolean> {
  if (!context.resolvableThreads || !context.isBotThread || !discussions.resolve) {
    return false;
  }
  await discussions.resolve(thread);
  return true;
}
