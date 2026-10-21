import { afterEach, describe, expect, it } from 'vitest';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { resolveBotCommitIdentity } from '../src/bot-identity.js';

function providerWith(identity: Partial<SourceControlProvider['identity']>): SourceControlProvider {
  return { identity } as unknown as SourceControlProvider;
}

afterEach(() => {
  delete process.env.BOT_NAME;
});

describe('resolveBotCommitIdentity(§28.4 bot commit 身份)', () => {
  it('用 provider 给的身份(GitHub App → `<id>+<slug>[bot]@users.noreply.github.com`)', async () => {
    const identity = { name: 'winnowl[bot]', email: '305734977+winnowl[bot]@users.noreply.github.com' };
    expect(await resolveBotCommitIdentity(providerWith({ commitIdentity: async () => identity }))).toEqual(identity);
  });

  it('provider 未实现 → 名字兜底', async () => {
    process.env.BOT_NAME = 'acmebot';
    expect(await resolveBotCommitIdentity(providerWith({}))).toEqual({
      name: 'acmebot',
      email: 'acmebot@users.noreply.github.com',
    });
  });

  it('查身份失败(null / 抛错)→ 名字兜底,不阻断交付', async () => {
    expect(await resolveBotCommitIdentity(providerWith({ commitIdentity: async () => null }))).toEqual({
      name: 'winnowl',
      email: 'winnowl@users.noreply.github.com',
    });
    const boom = providerWith({
      commitIdentity: async () => {
        throw new Error('403');
      },
    });
    expect((await resolveBotCommitIdentity(boom)).name).toBe('winnowl');
  });
});
