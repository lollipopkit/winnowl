import type { ProviderHostRef } from '@reviewbot/domain';
import { RestClient } from '@reviewbot/provider-http';
import { providerContractSuite, CONTRACT_CONFIG_FILE_TEXT, type FakeProviderServer } from '@reviewbot/testkit';
import { GitlabProvider } from '../src/index.js';

const HOST_ID = '018f9a3c-0000-7000-8000-0000000000a1';
const REPO_ID = '018f9a3c-0000-7000-8000-0000000000a2';
const INST_ID = '018f9a3c-0000-7000-8000-0000000000a3';
const CR_ID = '018f9a3c-0000-7000-8000-0000000000a4';
const ISSUE_ID = '018f9a3c-0000-7000-8000-0000000000a5';

function host(baseUrl: string): ProviderHostRef {
  return { id: HOST_ID, provider: 'gitlab', baseUrl, apiUrl: baseUrl, isSaas: true };
}

const mr = {
  id: 5001,
  iid: 7,
  title: 'Add login',
  description: 'desc',
  state: 'opened',
  work_in_progress: false,
  author: { id: 7, username: 'alice' },
  labels: ['feature'],
  source_branch: 'feature/login',
  target_branch: 'main',
  source_project_id: 55,
  target_project_id: 55,
  diff_refs: { base_sha: 'bbbb', start_sha: 'ssss', head_sha: 'aaaa' },
};

providerContractSuite({
  name: 'gitlab',
  unsupportedCapability: 'checksApi',
  unsupportedOperation: (provider) =>
    provider.discussions.createReviewBatch!(
      { id: CR_ID, repositoryId: REPO_ID, nativeId: '5001', number: 7, kind: 'merge-request' },
      { event: 'comment', comments: [] },
      { key: 'x' },
    ),
  makeProvider: (baseUrl) =>
    new GitlabProvider({
      client: new RestClient({ baseUrl }),
      host: host(baseUrl),
      resolveProject: () => ({ projectId: '55' }),
    }),
  refs: {
    changeRequest: { id: CR_ID, repositoryId: REPO_ID, nativeId: '5001', number: 7, kind: 'merge-request' },
    repository: {
      id: REPO_ID,
      providerHostId: HOST_ID,
      installationId: INST_ID,
      nativeId: '55',
      namespace: 'acme',
      name: 'app',
      cloneUrl: 'https://gitlab.com/acme/app.git',
      defaultBranch: 'main',
    },
    issue: { id: ISSUE_ID, repositoryId: REPO_ID, nativeId: '10', number: 3 },
    thread: {
      nativeId: 'disc-1',
      changeRequest: { id: CR_ID, repositoryId: REPO_ID, nativeId: '5001', number: 7, kind: 'merge-request' },
    },
    anchor: { path: 'src/a.ts', side: 'head', line: 10 },
  },
  configure: (server: FakeProviderServer) => {
    server
      .on('GET', '/projects/55/merge_requests/7/diffs', {
        body: [
          { old_path: 'src/a.ts', new_path: 'src/a.ts', new_file: false, deleted_file: false, renamed_file: false, diff: '@@' },
        ],
      })
      .on('GET', '/projects/55/merge_requests/7', { body: mr })
      .on('POST', '/projects/55/merge_requests/7/discussions/disc-1/notes', { status: 201, body: { id: 333 } })
      .on('POST', '/projects/55/merge_requests/7/discussions', { status: 201, body: { id: 'disc-x', notes: [{ id: 222 }] } })
      // Idempotency lookup finds no marker, so a new note is POSTed.
      .on('GET', '/projects/55/merge_requests/7/notes', { body: [] })
      .on('GET', '/projects/55/issues', { body: [] })
      .on('POST', '/projects/55/merge_requests/7/notes', { status: 201, body: { id: 111 } })
      .on('POST', '/projects/55/statuses/', { status: 201, body: { id: 444 } })
      .on('POST', '/projects/55/issues', { status: 201, body: { id: 555, iid: 9, web_url: 'u' } })
      .on('POST', '/projects/55/merge_requests/7/award_emoji', { status: 201, body: { id: 777, name: 'eyes' } })
      .on('POST', '/projects/55/issues/3/award_emoji', { status: 201, body: { id: 778, name: 'eyes' } })
      .on('PUT', '/projects/55/merge_requests/7/notes/111', { status: 200, body: { id: 111 } })
      .on('GET', '/projects/55/repository/files/.winnowl.yaml', {
        body: { content: Buffer.from(CONTRACT_CONFIG_FILE_TEXT, 'utf8').toString('base64'), encoding: 'base64' },
      });
  },
});
