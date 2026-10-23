import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { reviewTriggerTicked } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { RunnerSetupError } from '../src/executor-error.js';
import { createStatusComment, type ReviewedSummary } from '../src/status-comment.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const OTHER_CR = uuidv7();

describe('status comment', () => {
  let db: Db;
  let stop: () => Promise<void>;
  const comments = new Map<string, string>();
  const provider = {
    discussions: {
      listThreads: async () => [],
      listTopLevelComments: async () => [...comments].map(([nativeId, body]) => ({ nativeId, body, isBot: true })),
      createTopLevelComment: async (_t: unknown, body: { markdown: string }) => {
        const nativeId = String(comments.size + 1);
        comments.set(nativeId, body.markdown);
        return { nativeId };
      },
      editComment: async (ref: { nativeId: string }, body: { markdown: string }) => {
        comments.set(ref.nativeId, body.markdown);
      },
    },
  } as unknown as SourceControlProvider;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    for (const [id, number] of [[CR, 1], [OTHER_CR, 2]] as const) {
      await db.insertInto('change_requests').values({ id, tenant_id: TENANT, repository_id: REPO, native_id: String(number), number, kind: 'pull-request', source_branch: null, target_branch: null, state: 'open', draft: false, author: null, author_provider_id: null, created_at: new Date(), updated_at: new Date() }).execute();
    }
  });

  afterAll(async () => {
    await stop?.();
  });

  const status = () => createStatusComment({ db, buildProvider: async () => provider });
  const target = { tenantId: TENANT, repositoryId: REPO, changeRequestId: CR };

  it('explains a skip with a trigger checkbox and rewrites the same comment as the review moves on', async () => {
    await status().skipped(target, { code: 'too-many-files', count: 557, limit: 300 });
    expect(comments.size).toBe(1);
    const skipped = [...comments.values()][0]!;
    expect(skipped).toContain('557');
    // The ticked body is recognized by ingress.
    expect(reviewTriggerTicked(skipped, skipped.replace('- [ ]', '- [x]'))).toBe(true);

    await status().requested(target, 'alice');
    // The actor is the one who ticked the box; a bare mention would only notify them about their own click.
    expect([...comments.values()][0]).toContain('`@alice`');
    await status().reviewing(target);
    expect(comments.size).toBe(1);
    expect([...comments.values()][0]).toContain('Review in progress');
    await status().reviewed(target, summary());
    const done = [...comments.values()][0]!;
    expect(done).toContain('`abcdef1`');
    expect(done).toContain('the results are in the review');
    expect(done).toContain('🔴 High');
    expect(done).toContain('2 blocking finding(s)');
    expect(done).toContain('📝 Walkthrough');
    // The walkthrough is model-written: escaped so it cannot close the details block.
    expect(done).toContain('**Ingest &lt;/details&gt;**');
    expect(done).toContain('Review again');
  });

  const summary = (over: Partial<ReviewedSummary> = {}): ReviewedSummary => ({
    headSha: 'abcdef1234',
    blocking: { count: 2, severe: true },
    nitpicks: 1,
    incomplete: false,
    resultsPosted: true,
    files: { reviewed: 10, deferred: 0, unfinished: 0 },
    walkthrough: [{ title: 'Ingest </details>', summary: 'Adds the pipeline.' }],
    ...over,
  });

  it('does not point at a review that was never posted', async () => {
    await status().reviewed(target, summary({ resultsPosted: false, blocking: { count: 0, severe: false } }));
    const body = [...comments.values()][0]!;
    expect(body).toContain('nothing in it needed a review comment');
    expect(body).not.toContain('the results are in the review');
  });

  it('review in rounds: says how many files are left and offers to continue', async () => {
    await status().reviewed(target, summary({ files: { reviewed: 300, deferred: 257, unfinished: 0 }, incomplete: true, blocking: { count: 0, severe: false } }));
    const body = [...comments.values()][0]!;
    expect(body).toContain('Reviewed in rounds');
    expect(body).toContain('300');
    expect(body).toContain('257');
    expect(body).toContain('Continue with the remaining files');
    expect(body).toContain('⚪ Unknown');
    expect(reviewTriggerTicked(body, body.replace('- [ ]', '- [x]'))).toBe(true);
  });

  // Files a run failed to finish are not review rounds: no round limit was hit.
  it('files the run did not finish: says so instead of claiming a review in rounds', async () => {
    await status().reviewed(target, summary({ files: { reviewed: 24, deferred: 0, unfinished: 8 }, incomplete: true, blocking: { count: 0, severe: false } }));
    const body = [...comments.values()][0]!;
    expect(body).toContain('Review not finished');
    expect(body).not.toContain('Reviewed in rounds');
    expect(body).toContain('24 file(s); 8 were not finished');
    expect(body).toContain('Continue with the remaining files');
  });

  it('next round started on its own: says so and offers no checkbox', async () => {
    await status().reviewed(
      target,
      summary({ files: { reviewed: 40, deferred: 0, unfinished: 51 }, continuing: true, incomplete: true, blocking: { count: 0, severe: false } }),
    );
    const body = [...comments.values()][0]!;
    expect(body).toContain('Reviewed in rounds');
    expect(body).toContain('40 file(s); 51 remain. The next round has started on its own.');
    expect(body).not.toContain('Continue with the remaining files');
    expect(body).not.toContain('- [ ]');
  });

  it('a failure in GitHub Actions offers the retry box, unless a re-run cannot help', async () => {
    const body = () => [...comments.values()][0]!;
    await status().failed(target, new RunnerSetupError('actions-failed', 'deadline exceeded'));
    expect(body()).toContain('deadline exceeded');
    expect(body()).toContain('- [ ]');
    await status().failed(target, new RunnerSetupError('actions-no-rerun', 'permission'));
    expect(body()).toContain('Actions (read and write) permission');
    expect(body()).not.toContain('- [ ]');
    await status().failed(target, new RunnerSetupError('actions-fork'));
    expect(body()).not.toContain('- [ ]');
  });

  it('lists suggested reviewers without mentioning them', async () => {
    await status().reviewed(target, summary({ reviewers: { logins: ['alice', 'bob'], requested: false } }));
    const suggested = [...comments.values()][0]!;
    // A bare @login notifies: it must be in backticks.
    expect(suggested).toContain('**Suggested reviewers:** `@alice`, `@bob`');
    expect(suggested).not.toMatch(/(^|[^`])@alice/);
    await status().reviewed(target, summary({ reviewers: { logins: ['alice'], requested: true } }));
    expect([...comments.values()][0]).toContain('**Requested reviewers:** `@alice`');
  });

  it('every pull request gets one status comment, created when the review starts', async () => {
    const other = { ...target, changeRequestId: OTHER_CR };
    const before = comments.size;
    await status().reviewing(other);
    await status().reviewed(other, summary({ blocking: { count: 0, severe: false } }));
    expect(comments.size).toBe(before + 1);
    expect([...comments.values()].at(-1)).toContain('🟢 Low');
  });

  it('rewrites a denied request even when the text is unchanged, so the box is unticked again', async () => {
    await status().denied(target, 'mallory');
    const id = [...comments.keys()][0]!;
    comments.set(id, comments.get(id)!.replace('- [ ]', '- [x]'));
    await status().denied(target, 'mallory');
    expect(comments.get(id)).toContain('- [ ]');
  });
});
