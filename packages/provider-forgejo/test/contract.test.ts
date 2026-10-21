import type { ProviderHostRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { providerContractSuite, CONTRACT_CONFIG_FILE_TEXT, type FakeProviderServer } from '@reviewbot/testkit';
import { ForgejoProvider } from '../src/index.js';

const HOST_ID = '018f9a3c-0000-7000-8000-0000000000b1';
const REPO_ID = '018f9a3c-0000-7000-8000-0000000000b2';
const INST_ID = '018f9a3c-0000-7000-8000-0000000000b3';
const CR_ID = '018f9a3c-0000-7000-8000-0000000000b4';
const ISSUE_ID = '018f9a3c-0000-7000-8000-0000000000b5';

function host(baseUrl: string): ProviderHostRef {
  return { id: HOST_ID, provider: 'forgejo', baseUrl, apiUrl: baseUrl, isSaas: false };
}

const pull = {
  id: 5001,
  number: 7,
  title: 'Add login',
  body: 'desc',
  state: 'open',
  merged: false,
  draft: false,
  mergeable: true,
  merge_base: 'cccc',
  user: { id: 7, login: 'alice' },
  head: { sha: 'aaaa', ref: 'feature/login', repo: { id: 900 } },
  base: { sha: 'bbbb', ref: 'main', repo: { id: 900 } },
  labels: [{ name: 'feature' }],
};

providerContractSuite({
  name: 'forgejo',
  unsupportedCapability: 'checksApi',
  unsupportedOperation: (provider) =>
    provider.discussions.createReviewBatch!(
      { id: CR_ID, repositoryId: REPO_ID, nativeId: '5001', number: 7, kind: 'pull-request' },
      { event: 'comment', comments: [] },
      { key: 'x' },
    ),
  makeProvider: (baseUrl) =>
    new ForgejoProvider({
      client: new RestClient({ baseUrl }),
      host: host(baseUrl),
      resolveRepo: () => ({ owner: 'acme', repo: 'app' }),
    }),
  refs: {
    changeRequest: { id: CR_ID, repositoryId: REPO_ID, nativeId: '5001', number: 7, kind: 'pull-request' },
    repository: {
      id: REPO_ID,
      providerHostId: HOST_ID,
      installationId: INST_ID,
      nativeId: '900',
      namespace: 'acme',
      name: 'app',
      cloneUrl: 'https://forgejo.example/acme/app.git',
      defaultBranch: 'main',
    },
    issue: { id: ISSUE_ID, repositoryId: REPO_ID, nativeId: '10', number: 3 },
    thread: {
      nativeId: '500',
      changeRequest: { id: CR_ID, repositoryId: REPO_ID, nativeId: '5001', number: 7, kind: 'pull-request' },
    },
    anchor: { path: 'src/a.ts', side: 'head', line: 10 },
  },
  configure: (server: FakeProviderServer) => {
    server
      .on('GET', '/repos/acme/app/pulls/7/files', {
        body: [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
      })
      .on('GET', '/repos/acme/app/pulls/7', { body: pull })
      .on('POST', '/repos/acme/app/pulls/7/reviews', { status: 200, body: { id: 222 } })
      // Idempotency lookup finds no marker, so a new comment is POSTed.
      .on('GET', '/repos/acme/app/issues/7/comments', { body: [] })
      .on('GET', '/repos/acme/app/issues', { body: [] })
      .on('POST', '/repos/acme/app/issues/7/comments', { status: 201, body: { id: 111 } })
      .on('POST', '/repos/acme/app/statuses/', { status: 201, body: { id: 444 } })
      .on('POST', '/repos/acme/app/issues', { status: 201, body: { id: 555, number: 9 } })
      .on('POST', '/repos/acme/app/issues/7/reactions', { status: 201, body: { id: 777, content: 'eyes' } })
      .on('POST', '/repos/acme/app/issues/3/reactions', { status: 201, body: { id: 778, content: 'eyes' } })
      .on('PATCH', '/repos/acme/app/issues/comments/111', { status: 200, body: { id: 111 } })
      .on('GET', '/repos/acme/app/contents/.winnowl.yaml', {
        body: { content: Buffer.from(CONTRACT_CONFIG_FILE_TEXT, 'utf8').toString('base64'), encoding: 'base64' },
      });
  },
});
