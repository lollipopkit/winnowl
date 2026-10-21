import type { ChangeRequestRef } from '@reviewbot/domain';
import type { ChangeRequestApi } from '@reviewbot/provider-contracts';
import { upsertSummarySection } from '@reviewbot/publisher';

/**
 * Upserts the Summary into the PR/MR body, replacing only the marked section (idempotent).
 * Undefined when the provider cannot edit descriptions; callers then post a Summary comment.
 */
export function createDescriptionUpdater(
  changes: Pick<ChangeRequestApi, 'getDescription' | 'updateDescription'>,
  changeRequest: ChangeRequestRef,
): ((summaryMarkdown: string) => Promise<void>) | undefined {
  const { getDescription, updateDescription } = changes;
  if (!getDescription || !updateDescription) return undefined;
  return async (summaryMarkdown: string): Promise<void> => {
    const current = await getDescription(changeRequest);
    await updateDescription(changeRequest, upsertSummarySection(current, summaryMarkdown));
  };
}
