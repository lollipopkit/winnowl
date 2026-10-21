import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnsupportedCapabilityError } from '@reviewbot/provider-contracts';
import type {
  DiscussionThreadRef,
  ProviderAnchor,
  SourceControlProvider,
} from '@reviewbot/provider-contracts';
import type {
  ChangeRequestCapabilities,
  ChangeRequestRef,
  IssueRef,
  RepositoryRef,
} from '@reviewbot/domain';
import { FakeProviderServer } from './fake-provider-server.js';

export interface ProviderContractRefs {
  changeRequest: ChangeRequestRef;
  repository: RepositoryRef;
  issue: IssueRef;
  thread: DiscussionThreadRef;
  anchor: ProviderAnchor;
}

export interface ProviderContractHarness {
  name: string;
  configure: (server: FakeProviderServer) => void;
  makeProvider: (baseUrl: string) => SourceControlProvider;
  refs: ProviderContractRefs;
  /** Omitted: the provider supports every tested capability. */
  unsupportedCapability?: keyof ChangeRequestCapabilities;
  /** Must throw UnsupportedCapabilityError; omitted together with unsupportedCapability. */
  unsupportedOperation?: (provider: SourceControlProvider) => Promise<unknown>;
}

/** Each harness registers this under its provider's file endpoint and encoding. */
export const CONTRACT_CONFIG_FILE_TEXT = 'reviews:\n  auto:\n    enabled: true\n';

/** Behaviour contract every provider adapter must pass, run against FakeProviderServer. */
export function providerContractSuite(harness: ProviderContractHarness): void {
  describe(`provider contract: ${harness.name}`, () => {
    let server: FakeProviderServer;
    let provider: SourceControlProvider;
    const { refs } = harness;
    const idem = { key: 'test-idem-key' };

    beforeAll(async () => {
      server = new FakeProviderServer();
      harness.configure(server);
      const url = await server.listen();
      provider = harness.makeProvider(url);
    });

    afterAll(async () => {
      await server.close();
    });

    it('get change request 返回 canonical ChangeRequest', async () => {
      const cr = await provider.changes.get(refs.changeRequest);
      expect(cr.ref.id).toBe(refs.changeRequest.id);
      expect(typeof cr.title).toBe('string');
      expect(cr.capabilities).toBeDefined();
      expect(['open', 'closed', 'merged']).toContain(cr.state);
    });

    it('getRevision 返回 base/head/mergeBase SHA', async () => {
      const rev = await provider.changes.getRevision(refs.changeRequest);
      expect(rev.headSha).toBeTruthy();
      expect(rev.baseSha).toBeTruthy();
      expect(rev.mergeBaseSha).toBeTruthy();
      expect(rev.changeRequestId).toBe(refs.changeRequest.id);
    });

    it('listChangedFiles 返回文件数组', async () => {
      const files = await provider.changes.listChangedFiles(refs.changeRequest);
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]?.newPath).toBeTruthy();
    });

    it('createTopLevelComment 返回 receipt 并发出请求', async () => {
      const before = server.requests.length;
      const receipt = await provider.discussions.createTopLevelComment(
        { kind: 'change-request', ref: refs.changeRequest },
        { markdown: 'hello' },
        idem,
      );
      expect(receipt.nativeId).toBeTruthy();
      expect(server.requests.length).toBeGreaterThan(before);
    });

    it('createInlineComment 返回 receipt', async () => {
      const receipt = await provider.discussions.createInlineComment(
        refs.changeRequest,
        refs.anchor,
        { markdown: 'inline' },
        idem,
      );
      expect(receipt.nativeId).toBeTruthy();
    });

    it('reply 返回 receipt', async () => {
      const receipt = await provider.discussions.reply(refs.thread, { markdown: 'reply' }, idem);
      expect(receipt.nativeId).toBeTruthy();
    });

    it('checks.createOrUpdate 返回 receipt', async () => {
      const receipt = await provider.checks.createOrUpdate(
        refs.repository,
        {
          name: 'reviewbot',
          status: 'completed',
          conclusion: 'success',
          headSha: refs.changeRequest ? 'headsha' : 'x',
        },
        idem,
      );
      expect(receipt.nativeId).toBeTruthy();
    });

    it('issues.create 返回 issue ref', async () => {
      const receipt = await provider.issues.create(
        refs.repository,
        { title: 't', body: { markdown: 'b' } },
        idem,
      );
      expect(receipt.ref.nativeId).toBeTruthy();
      expect(receipt.ref.repositoryId).toBe(refs.repository.id);
    });

    it('editComment 成功', async () => {
      await expect(
        provider.discussions.editComment(
          { nativeId: '111', changeRequest: refs.changeRequest, scope: 'conversation' },
          { markdown: 'edited' },
        ),
      ).resolves.toBeUndefined();
    });

    it('reactions(§ack):支持则 addToChangeRequest/addToIssue 成功(harness 注册对应端点)', async () => {
      if (!provider.reactions) return; // optional API
      await expect(provider.reactions.addToChangeRequest(refs.changeRequest, 'eyes')).resolves.toBeUndefined();
      await expect(provider.reactions.addToIssue(refs.issue, 'eyes')).resolves.toBeUndefined();
    });

    it('getFileContent(§37 免 clone 复核):支持则返回文本,文件不存在 → null', async () => {
      const read = provider.repositories.getFileContent;
      if (!read) return; // optional API
      await expect(read(refs.repository, '.winnowl.yaml')).resolves.toBe(CONTRACT_CONFIG_FILE_TEXT);
      // A missing file (404) must return null, not throw.
      await expect(read(refs.repository, 'no-such-file.yaml')).resolves.toBeNull();
    });

    it.runIf(harness.unsupportedCapability !== undefined)('capability 协商:不支持能力为 false', async () => {
      const caps = await provider.capabilities.forChangeRequest(refs.changeRequest);
      expect(caps[harness.unsupportedCapability!]).toBe(false);
    });

    it.runIf(harness.unsupportedOperation !== undefined)('调用不支持的操作显式抛 UnsupportedCapabilityError', async () => {
      await expect(harness.unsupportedOperation!(provider)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    });
  });
}
