import { botName } from '@reviewbot/domain';
import type { GitCommitIdentity, SourceControlProvider } from '@reviewbot/provider-contracts';

/**
 * Git identity for bot commits. Forges attach commits to accounts by email, so it must come from the
 * provider (GitHub App: `<bot user id>+<slug>[bot]@users.noreply.github.com`); a made-up noreply address
 * shows as an unlinked name. Falls back to the name only when the lookup fails, so delivery is never blocked.
 */
export async function resolveBotCommitIdentity(provider: SourceControlProvider): Promise<GitCommitIdentity> {
  const resolved = await provider.identity.commitIdentity?.().catch(() => null);
  return resolved ?? { name: botName(), email: `${botName()}@users.noreply.github.com` };
}
